/**
 * @fileoverview Socrata SODA API client for CDC Open Data portal.
 * Handles discovery, metadata, and SoQL queries with rate-limit-aware request spacing.
 * Failed responses are classified by status into distinct contract reasons so callers can
 * tell a permanent access decision (403) from a transient upstream outage (5xx). A request
 * that never yields a readable body — unreachable, cut off, past its deadline, or answered with
 * a 2xx body that fails its schema — is the same retryable outage as a 5xx.
 * @module services/socrata/socrata-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { USER_AGENT } from '@/services/user-agent.js';
import { nonBlank, toPlainText } from '@/utils/text.js';
import {
  type AccessPoint,
  type CatalogAssetType,
  type CatalogDataset,
  type DatasetColumn,
  type DatasetMetadata,
  type DiscoverResult,
  type QueryResult,
  REQUEST_TIMEOUT_MS,
  type SocrataDomain,
  type VocabularyTerm,
} from './types.js';

const MIN_REQUEST_INTERVAL_MS = 250;

/**
 * Explicit page size for the tag vocabulary. `domain_tags` answers a request that names no
 * limit with 100 values and reports `resultSetSize: 100` beside them, so the response looks
 * complete at a small fraction of the vocabulary and nothing in it says otherwise. Measured
 * live, `data.cdc.gov` carries roughly 1,600 tags and a larger limit returns the same set — so
 * this value reaches the whole set rather than trading one silent cap for another.
 */
const TAG_VOCABULARY_LIMIT = 10_000;

/**
 * Deadline on the live row count, which annotates a metadata response that has usually
 * already arrived. Shorter than `REQUEST_TIMEOUT_MS` because the answer it decorates is
 * complete without it, and a stalled count would otherwise hold that answer for the full
 * request deadline. Measured live, the request returns in well under a second.
 */
const ROW_COUNT_TIMEOUT_MS = 5_000;

/**
 * Body schemas, one per endpoint, each naming what its reader needs. A 2xx body that fails one
 * is an upstream fault — an edge error page, a changed shape — never data: read leniently,
 * `{"message":"ok"}` passes for an empty catalog page or a non-tabular asset. Optional fields
 * are `nullish` because Socrata sends `null` for an absent value as readily as it omits the key.
 */
const CatalogSearchBody = z.object({
  results: z.array(
    z.object({
      resource: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullish(),
        type: z.string().nullish(),
        columns_field_name: z.array(z.string()).nullish(),
        columns_datatype: z.array(z.string()).nullish(),
        data_updated_at: z.string().nullish(),
        page_views: z.object({ page_views_total: z.number().nullish() }).nullish(),
        // Empty, not absent, on an entry built on no other dataset.
        parent_fxf: z.array(z.string()).nullish(),
      }),
      classification: z
        .object({
          domain_category: z.string().nullish(),
          domain_tags: z.array(z.string()).nullish(),
        })
        .nullish(),
      /**
       * `access_points` maps publisher free-text labels to URLs. It stays `unknown` here and is
       * read by `accessPointsOf`: a Zod record copies each key onto a fresh object, where a label
       * of `__proto__` would set that object's prototype instead of surviving as a key.
       */
      metadata: z.object({ access_points: z.unknown().optional() }).nullish(),
      permalink: z.string().nullish(),
    }),
  ),
  resultSetSize: z.number(),
});

/** `domain_categories` / `domain_tags` rows; a row with an unusable value or count is dropped by the reader. */
const VocabularyBody = z.object({ results: z.array(z.record(z.string(), z.unknown())) });

/** `/api/views/{id}.json`. `columns` is empty, not absent, on a chart, map, or story. */
const MetadataDocumentBody = z.object({
  name: z.string(),
  description: z.string().nullish(),
  // The dataset a chart, map, or filter is a view of; absent on every other asset.
  modifyingViewUid: z.string().nullish(),
  rowsUpdatedAt: z.number().nullish(),
  attribution: z.string().nullish(),
  // `null` on a dataset the publisher gave no license.
  license: z.object({ name: z.string().nullish() }).nullish(),
  /**
   * `custom_fields` maps publisher-labelled sections to publisher-labelled fields. It stays
   * `unknown` and is read by `customField`, for the reason `access_points` is.
   */
  metadata: z.object({ custom_fields: z.unknown().optional() }).nullish(),
  columns: z.array(
    z.object({
      fieldName: z.string(),
      dataTypeName: z.string(),
      description: z.string().nullish(),
      // Read through `Number()` and kept only when finite: the cached figure is an annotation.
      cachedContents: z.object({ count: z.unknown().optional() }).nullish(),
    }),
  ),
});

/** SODA rows, a `count(*)` answer included. Values are strings, or GeoJSON objects for geo columns. */
const RowsBody = z.array(z.record(z.string(), z.unknown()));

/**
 * The `only` spelling of each asset type. Measured live, every plural answered with the full
 * count on every draw, while the bare `dataset` answered an empty page on some.
 */
const ONLY_FORMS = {
  dataset: 'datasets',
  filter: 'filters',
  chart: 'charts',
  map: 'maps',
  story: 'stories',
  file: 'files',
  href: 'hrefs',
} as const satisfies Record<CatalogAssetType, string>;

/**
 * A catalog entry's `metadata.access_points` as `{ label, url }` entries, in the order the parsed
 * body holds them — upstream order, save that a JavaScript object lists an integer-like key
 * first. Read off the parsed JSON itself, so every label is kept as an own key, `__proto__` and
 * `constructor` included. An entry whose URL is not a non-empty string is dropped.
 */
function accessPointsOf(value: unknown): AccessPoint[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([label, url]) =>
    typeof url === 'string' && url.length > 0 ? [{ label, url }] : [],
  );
}

/** Publisher text with its surrounding whitespace off; absent when not a string or blank. */
function publisherText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

/** `value[key]` when `value` is a plain object carrying `key` as its own property. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * One field of a metadata document's `custom_fields`, read off the parsed JSON by own-key
 * lookups, section first and field second, as the portal's metadata form labels them. A
 * section or field of any other shape reads as absent rather than failing the document.
 */
function customField(customFields: unknown, section: string, field: string): string | undefined {
  return publisherText(ownValue(ownValue(customFields, section), field));
}

/** Options for discovering datasets. */
export interface DiscoverOptions {
  /** Limits the search to these asset types; omitted or empty searches every type. */
  assetTypes?: readonly CatalogAssetType[] | undefined;
  category?: string | undefined;
  domain?: SocrataDomain | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  order?: string | undefined;
  query?: string | undefined;
  tags?: string[] | undefined;
}

/** Options for querying a dataset via SoQL. */
export interface QueryOptions {
  datasetId: string;
  domain?: SocrataDomain | undefined;
  group?: string | undefined;
  having?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  order?: string | undefined;
  search?: string | undefined;
  select?: string | undefined;
  where?: string | undefined;
}

/** The `$limit` a data request sent on the wire beside the one its caller asked for. */
interface OverFetch {
  offset: number;
  requested: number;
  sent: number;
}

interface FetchOptions {
  /**
   * The data endpoint's over-fetch, so a 400 that quotes the compiled query relays the
   * caller's `$limit` rather than the probe's.
   */
  overFetch?: OverFetch;
  /** Deadline over headers and body; `REQUEST_TIMEOUT_MS` unless the request needs a shorter one. */
  timeoutMs?: number;
}

/**
 * Strip the trailing Scala `; position: Map(...)` debug dump that Socrata appends
 * to SoQL error messages — noise for an agent acting on the error.
 */
function stripPositionTail(message: string): string {
  return message.replace(/;\s*position:\s*Map\([\s\S]*$/, '').trimEnd();
}

/**
 * Socrata's parse errors quote the SoQL it compiled (`data.query`), which ends in the
 * server-added `limit <sent> offset <n>`. Swap that tail back to the caller's own limit so the
 * relayed message agrees with `effectiveQuery` — in every copy, since an unexpected-character
 * error quotes the query twice: inline, and again on its own line above a caret line. Only the
 * tail moves and every caller clause precedes it, so a `character N` position, and the caret
 * under the second copy, still point at the same character. A message that quotes no such
 * query is returned unchanged.
 */
function withCallerLimit(message: string, query: unknown, overFetch?: OverFetch): string {
  if (!overFetch || typeof query !== 'string') return message;
  const { offset, requested, sent } = overFetch;
  for (const [limit, offsetKeyword] of [
    ['limit', 'offset'],
    ['LIMIT', 'OFFSET'],
  ] as const) {
    const tail = ` ${limit} ${sent} ${offsetKeyword} ${offset}`;
    if (!query.endsWith(tail)) continue;
    const callerQuery = `${query.slice(0, -tail.length)} ${limit} ${requested} ${offsetKeyword} ${offset}`;
    return message.replaceAll(query, () => callerQuery);
  }
  return message;
}

/**
 * Whether the caret of a Socrata error `position` sits in the ORDER BY clause of the query line
 * it quotes; false when the position carries no line and column. Socrata normalizes that line —
 * keywords upper-case, identifiers backticked, literals single-quoted — so the clause opens at
 * the first ` ORDER BY ` outside a quote, and only LIMIT and OFFSET follow it. One pass up to
 * the caret, since the line is as long as the caller's query.
 */
function caretInOrderBy(position: unknown): boolean {
  const { column, line } = (position ?? {}) as { column?: unknown; line?: unknown };
  if (typeof line !== 'string' || typeof column !== 'number') return false;
  const caret = Math.min(column - 1, line.length);
  let quote: string | undefined;
  for (let i = 0; i < caret; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '`') {
      quote = char;
    } else if (char === ' ' && line.startsWith(' ORDER BY ', i)) {
      return true;
    }
  }
  return false;
}

/**
 * Render the SoQL parameters as `key=value` pairs carrying each clause in the exact text the
 * caller supplied, so a clause can be lifted out of the echo and fed straight back into the
 * matching tool parameter. Reading the values back off `URLSearchParams` sidesteps the trap
 * in decoding its output: it writes a space as `+` and a caller's literal `+` as `%2B`, so
 * `decodeURIComponent` alone leaves every space as a plus sign, and swapping plus for space
 * after decoding erases the arithmetic `+` in an expression like `deaths + births`.
 */
function decodedQueryString(params: URLSearchParams): string {
  return [...params].map(([key, value]) => `${key}=${value}`).join('&');
}

/**
 * Pull Socrata's own `message` out of a JSON error body. Returns undefined when the body
 * isn't JSON or carries no message, so callers can fall back to a status-only description.
 */
function socrataMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message = parsed.message;
    return typeof message === 'string' && message.length > 0 ? message.slice(0, 200) : undefined;
  } catch {
    return;
  }
}

export class SocrataService {
  private lastRequestTime = 0;

  /**
   * Resolve the SODA base URL for a request. An explicit allowlisted `domain` selects the
   * host; otherwise the configured `CDC_BASE_URL` (default `https://data.cdc.gov`) applies.
   * Every tool declares `domain` with a default, so Zod always supplies one and the env
   * override is reached only from `cdc://datasets/{datasetId}`, the one call that omits it.
   */
  private baseUrlFor(domain: SocrataDomain | undefined): string {
    return domain ? `https://${domain}` : getServerConfig().baseUrl;
  }

  /**
   * Search the CDC dataset catalog by keyword, category, or tag.
   */
  async discover(options: DiscoverOptions, signal?: AbortSignal): Promise<DiscoverResult> {
    const config = getServerConfig();
    const domain = options.domain ?? 'data.cdc.gov';
    const params = new URLSearchParams({
      domains: domain,
      search_context: domain,
    });

    const query = nonBlank(options.query);
    const category = nonBlank(options.category);
    if (query) params.set('q', query);
    if (category) params.set('categories', category);
    for (const tag of options.tags ?? []) {
      if (nonBlank(tag)) params.append('tags', tag);
    }
    // One comma-joined parameter; an empty `only=` matches nothing, so no types sends none.
    if (options.assetTypes?.length) {
      params.set('only', options.assetTypes.map((type) => ONLY_FORMS[type]).join(','));
    }
    params.set('limit', String(options.limit ?? 10));
    params.set('offset', String(options.offset ?? 0));
    if (options.order) params.set('order', options.order);

    const url = `${config.catalogUrl}?${params}`;
    const { results, resultSetSize } = await this.fetchJson(url, CatalogSearchBody, signal);

    const datasets: CatalogDataset[] = results.map(
      ({ resource, classification, metadata, permalink }) => {
        const category = classification?.domain_category;
        const tags = classification?.domain_tags;
        const pageViews = resource.page_views?.page_views_total;
        const accessPoints = accessPointsOf(metadata?.access_points);
        const parentIds = resource.parent_fxf;
        return {
          id: resource.id,
          name: resource.name,
          ...(resource.type ? { assetType: resource.type } : {}),
          ...(permalink ? { permalink } : {}),
          ...(accessPoints.length > 0 ? { accessPoints } : {}),
          ...(parentIds?.length ? { parentIds } : {}),
          ...(resource.description ? { description: resource.description } : {}),
          ...(category ? { category } : {}),
          ...(tags ? { tags } : {}),
          ...(resource.columns_field_name ? { columnNames: resource.columns_field_name } : {}),
          ...(resource.columns_datatype ? { columnTypes: resource.columns_datatype } : {}),
          ...(resource.data_updated_at ? { updatedAt: resource.data_updated_at } : {}),
          ...(typeof pageViews === 'number' ? { pageViews } : {}),
        };
      },
    );

    return { datasets, totalCount: resultSetSize };
  }

  /**
   * Every value in the catalog's category vocabulary for a domain, ranked by entry count.
   *
   * The whole vocabulary arrives in one request: `domain_categories` answers with a few dozen
   * values for both CDC hosts and reports the same figure as `resultSetSize`, well inside any
   * page size the endpoint applies.
   */
  listCategories(domain?: SocrataDomain, signal?: AbortSignal): Promise<VocabularyTerm[]> {
    return this.fetchVocabulary('domain_categories', 'domain_category', domain, signal);
  }

  /**
   * Every value in the catalog's tag vocabulary for a domain, ranked by entry count.
   *
   * Sends `TAG_VOCABULARY_LIMIT` explicitly — without it the endpoint returns a silent
   * hundred-value page.
   */
  listTags(domain?: SocrataDomain, signal?: AbortSignal): Promise<VocabularyTerm[]> {
    return this.fetchVocabulary('domain_tags', 'domain_tag', domain, signal, {
      limit: String(TAG_VOCABULARY_LIMIT),
    });
  }

  /**
   * Read one of the Discovery API's vocabulary endpoints, which are siblings of the catalog
   * search URL and answer `{ results: [{ <key>, count }] }`.
   *
   * A row whose value or count is missing or unusable is dropped rather than passed on as an
   * empty string or a `NaN`. The result is sorted by count descending with the value as a
   * tiebreak: callers rank against it — the near-miss notice and the tag page's threshold
   * bound both assume the order — so it is established here rather than assumed of upstream.
   */
  private async fetchVocabulary(
    path: 'domain_categories' | 'domain_tags',
    key: 'domain_category' | 'domain_tag',
    domain: SocrataDomain | undefined,
    signal: AbortSignal | undefined,
    extra?: Record<string, string>,
  ): Promise<VocabularyTerm[]> {
    const params = new URLSearchParams({ domains: domain ?? 'data.cdc.gov', ...extra });
    const { results } = await this.fetchJson(
      `${getServerConfig().catalogUrl}/${path}?${params}`,
      VocabularyBody,
      signal,
    );

    const terms: VocabularyTerm[] = [];
    for (const row of results) {
      const value = row[key];
      const datasetCount = Number(row.count);
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!Number.isInteger(datasetCount) || datasetCount < 0) continue;
      terms.push({ value, datasetCount });
    }

    return terms.sort((a, b) => b.datasetCount - a.datasetCount || a.value.localeCompare(b.value));
  }

  /**
   * Fetch full metadata and column schema for a dataset.
   *
   * A live `count(*)` runs alongside the metadata read rather than after it, and replaces
   * the cached row count when it succeeds. It is strictly an annotation: it is issued in
   * parallel, its failure is absorbed, and the metadata response is returned either way with
   * `rowCountSource` naming which figure is in hand. The caller's own cancellation is not a
   * count failure: a count it cuts short rethrows the abort instead of answering without it.
   *
   * @param domain - Allowlisted CDC Socrata host. Omit to use the configured default host.
   * @param options - `liveRowCount: false` returns the cached figure and issues one request,
   *   for callers that want the column list and will discard the row total anyway.
   */
  async getMetadata(
    datasetId: string,
    signal?: AbortSignal,
    domain?: SocrataDomain,
    options?: { liveRowCount?: boolean },
  ): Promise<DatasetMetadata> {
    const wantsLiveCount = options?.liveRowCount ?? true;
    const [documentResult, countResult] = await Promise.allSettled([
      this.fetchMetadataDocument(datasetId, signal, domain),
      wantsLiveCount
        ? this.countRows(datasetId, signal, domain)
        : Promise.resolve<number | undefined>(undefined),
    ]);

    if (documentResult.status === 'rejected') throw documentResult.reason as Error;
    if (countResult.status === 'rejected' && signal?.aborted) throw countResult.reason as Error;

    const metadata = documentResult.value;
    const liveCount = countResult.status === 'fulfilled' ? countResult.value : undefined;
    if (liveCount === undefined) return metadata;
    return { ...metadata, rowCount: liveCount, rowCountSource: 'live' };
  }

  /** The `/api/views/{id}.json` document, carrying the cached row count Socrata stored. */
  private async fetchMetadataDocument(
    datasetId: string,
    signal: AbortSignal | undefined,
    domain: SocrataDomain | undefined,
  ): Promise<DatasetMetadata> {
    const url = `${this.baseUrlFor(domain)}/api/views/${datasetId}.json`;
    const data = await this.fetchJson(url, MetadataDocumentBody, signal);

    const columns: DatasetColumn[] = data.columns.map((col) => ({
      fieldName: col.fieldName,
      dataType: col.dataTypeName,
      ...(col.description ? { description: col.description } : {}),
    }));

    const rawCount = data.columns[0]?.cachedContents?.count;
    const rowCount = rawCount != null ? Number(rawCount) : Number.NaN;
    const { rowsUpdatedAt } = data;
    const updatedAt =
      typeof rowsUpdatedAt === 'number' ? new Date(rowsUpdatedAt * 1000).toISOString() : undefined;
    const description = toPlainText(data.description ?? '');
    /**
     * The `Common Core` section, never `Common Core 3`: the later section repeats it in other
     * forms (`Monthly` beside `R/P1M`) and, measured across the catalog's tabular entries, adds
     * one coverage value and no cadence the first lacks.
     */
    const customFields = data.metadata?.custom_fields;
    const temporalCoverage = customField(customFields, 'Common Core', 'Temporal Applicability');
    const updateFrequency = customField(customFields, 'Common Core', 'Update Frequency');
    const geographicCoverage = customField(customFields, 'Common Core', 'Geographic Coverage');
    const citation = customField(customFields, 'Data Quality', 'Suggested Citation');
    const license = publisherText(data.license?.name);
    const attribution = publisherText(data.attribution);

    return {
      name: data.name,
      columns,
      ...(description ? { description } : {}),
      ...(data.modifyingViewUid ? { parentId: data.modifyingViewUid } : {}),
      ...(Number.isFinite(rowCount) ? { rowCount, rowCountSource: 'cached' as const } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(temporalCoverage ? { temporalCoverage } : {}),
      ...(updateFrequency ? { updateFrequency } : {}),
      ...(geographicCoverage ? { geographicCoverage } : {}),
      ...(citation ? { citation } : {}),
      ...(license ? { license } : {}),
      ...(attribution ? { attribution } : {}),
    };
  }

  /**
   * The dataset's current row total, as `count(*)` alone.
   *
   * Nothing else may ride in the `$select`: naming a real column changes what Socrata groups
   * over, so `$select=state,count(*)&$group=state` answers with a count per state rather than
   * the dataset total. The alias Socrata puts on the result has varied across SODA versions,
   * so the first value of the first row is read rather than a fixed key.
   *
   * The request runs under `ROW_COUNT_TIMEOUT_MS` rather than the full request deadline.
   */
  private async countRows(
    datasetId: string,
    signal: AbortSignal | undefined,
    domain: SocrataDomain | undefined,
  ): Promise<number | undefined> {
    const url = `${this.baseUrlFor(domain)}/resource/${datasetId}.json?${new URLSearchParams({
      $select: 'count(*)',
    })}`;

    const rows = await this.fetchJson(url, RowsBody, signal, { timeoutMs: ROW_COUNT_TIMEOUT_MS });
    const [value] = Object.values(rows[0] ?? {});
    const count = Number(value);
    return Number.isInteger(count) && count >= 0 ? count : undefined;
  }

  /**
   * Execute a SoQL query against a CDC dataset.
   *
   * The wire request asks for one row more than the caller's limit. The SODA data endpoint
   * reports no total, so that extra row is the only evidence that separates a result set
   * whose last page happens to fill the limit from one that was cut short. It is dropped
   * before returning and recorded as `hasMore`; the echoed `query`, and any error Socrata
   * raises quoting the query it compiled, keep the caller's own `$limit` so neither hands the
   * probe back.
   *
   * A blank or whitespace-only clause is omitted, as an absent one is; a clause with text in
   * it is sent exactly as given.
   */
  async query(options: QueryOptions, signal?: AbortSignal): Promise<QueryResult> {
    const params = new URLSearchParams();
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const clauses = [
      ['$q', options.search],
      ['$select', options.select],
      ['$where', options.where],
      ['$group', options.group],
      ['$having', options.having],
      ['$order', options.order],
    ] as const;
    for (const [key, value] of clauses) {
      const clause = nonBlank(value);
      if (clause) params.set(key, clause);
    }
    params.set('$limit', String(limit));
    params.set('$offset', String(offset));

    const query = decodedQueryString(params);
    params.set('$limit', String(limit + 1));

    const url = `${this.baseUrlFor(options.domain)}/resource/${options.datasetId}.json?${params}`;
    const fetched = await this.fetchJson(url, RowsBody, signal, {
      overFetch: { offset, requested: limit, sent: limit + 1 },
    });

    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;

    return { rows, rowCount: rows.length, query, hasMore };
  }

  private throwBadRequest(body: string, url: string, overFetch?: OverFetch): never {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Body wasn't JSON — fall through to generic.
    }

    // Socrata names the error code `errorCode` for query.soql.* (semantic) errors
    // but `code` for query.compiler.* (parse) errors — check both.
    const code = (parsed?.errorCode ?? parsed?.code) as string | undefined;
    const data = parsed?.data as Record<string, unknown> | undefined;
    const message = (parsed?.message ?? parsed?.error) as string | undefined;
    const rawMessage =
      typeof message === 'string' ? withCallerLimit(message, data?.query, overFetch) : message;

    if (code === 'query.soql.no-such-column') {
      const col = data?.column ?? 'unknown';
      throw validationError(
        `No such column "${col}". Use cdc_get_dataset_schema to see available columns for this dataset.`,
        { reason: 'no_such_column', column: col, url },
      );
    }
    if (code === 'query.soql.type-mismatch') {
      const detail = rawMessage?.split(';')[1]?.trim() ?? 'check column types';
      throw validationError(
        `SoQL type mismatch: ${detail}. Use cdc_get_dataset_schema to verify column data types.`,
        { reason: 'type_mismatch', url },
      );
    }
    if (code === 'query.soql.column-not-in-group-bys') {
      const col = data?.column ?? 'unknown';
      /**
       * In ORDER BY, adding the column to `group` makes Socrata accept the query and silently
       * splits every aggregate into finer rows — so that advice is given only for the SELECT
       * and HAVING positions, where it is one of two real fixes.
       */
      if (caretInOrderBy(data?.position)) {
        throw validationError(
          `Column "${col}" in the order clause is neither grouped nor aggregated, so it cannot order grouped rows. Order by the grouped columns or by aggregate aliases from select instead.`,
          { reason: 'invalid_query', column: col, url },
        );
      }
      throw validationError(
        `Column "${col}" must appear in GROUP BY or be wrapped in an aggregate (e.g. sum()). Add group="${col}" or aggregate it in select.`,
        { reason: 'invalid_query', column: col, url },
      );
    }
    if (
      code === 'query.compiler.malformed' &&
      rawMessage &&
      /Expected an expression, but got/i.test(rawMessage)
    ) {
      throw validationError(
        `SoQL parse error: ${stripPositionTail(rawMessage).slice(0, 200)}. If a column name matches a SoQL keyword (group, select, where, order, limit, offset, having, search), wrap it in backticks — e.g. \`group\`='By Year'.`,
        { reason: 'invalid_query', url },
      );
    }

    if (typeof rawMessage === 'string') {
      throw validationError(`Socrata query error: ${stripPositionTail(rawMessage).slice(0, 300)}`, {
        reason: 'invalid_query',
        url,
      });
    }

    throw validationError(`Socrata API error 400: ${body.slice(0, 300)}`, {
      reason: 'invalid_query',
      url,
    });
  }

  /**
   * One request to a Socrata endpoint, its body parsed through `schema`.
   *
   * The status ladder classifies every non-2xx response. Everything else that keeps a body from
   * becoming data is `upstream_error`: a request that fails before any response arrives, a body
   * cut off mid-transfer, a request still unfinished at its deadline, a 2xx body that is not
   * JSON, and JSON that fails `schema`. The caller's own cancellation is rethrown exactly as it
   * arrived.
   */
  private async fetchJson<T>(
    url: string,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined,
    { overFetch, timeoutMs = REQUEST_TIMEOUT_MS }: FetchOptions = {},
  ): Promise<T> {
    await this.throttle();
    const config = getServerConfig();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (config.appToken) headers['X-App-Token'] = config.appToken;

    /**
     * One controller ends the request on its deadline or on the caller's cancellation, over the
     * headers and the body read alike. The caller's reason is forwarded, so whatever it cuts
     * short rejects with exactly what the caller aborted with; whether the caller's signal fired
     * is what tells the two apart. A plain timer rather than `AbortSignal.timeout()`, which the
     * framework's own fetch helper avoids under Bun's stdio transport.
     */
    const request = new AbortController();
    const timer = setTimeout(() => request.abort(), timeoutMs);
    const cancel = () => request.abort(signal?.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel);

    const unreadable = (err: unknown, message: string): unknown => {
      if (signal?.aborted) return err;
      if (!request.signal.aborted) {
        return serviceUnavailable(message, { reason: 'upstream_error', url }, { cause: err });
      }
      const advice = new URL(url).pathname.includes('/resource/')
        ? ' A narrower where or select, or a smaller limit, answers sooner.'
        : '';
      return serviceUnavailable(
        `Socrata did not finish answering within ${timeoutMs / 1000} seconds, so the request was abandoned.${advice}`,
        { reason: 'upstream_error', url },
        { cause: err },
      );
    };

    let response: Response;
    let body: string;
    try {
      try {
        response = await globalThis.fetch(url, { headers, signal: request.signal });
      } catch (err) {
        throw unreadable(
          err,
          'Could not reach Socrata: the request failed before any response arrived (a network, DNS, or TLS failure).',
        );
      }
      try {
        body = await response.text();
      } catch (err) {
        // An error status classifies the failure by itself; its body only adds detail.
        if (response.ok || signal?.aborted) {
          throw unreadable(err, "Socrata's response was cut off before it finished arriving.");
        }
        body = '';
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }

    if (!response.ok) {
      if (response.status === 404) {
        /**
         * `dataset_not_found` covers a 404 from any of the three endpoints, and the two
         * catalog consumers reach it too. Telling them to verify a dataset ID and search
         * again with cdc_discover_datasets describes neither their failure nor a corrective
         * they can take, so the message names the endpoint that answered and leaves the
         * per-consumer advice to the contract recovery.
         */
        const catalog = url.startsWith(config.catalogUrl);
        throw notFound(
          catalog
            ? 'Socrata catalog endpoint not found (404). The Discovery API address did not resolve to a catalog.'
            : 'Dataset not found (404). Verify the dataset ID exists — it may have been retired or replaced.',
          { reason: 'dataset_not_found', url },
        );
      }
      if (response.status === 429) {
        throw rateLimited(
          'Rate limited by Socrata API (429). Retry after a brief delay. Consider setting CDC_APP_TOKEN for higher limits.',
          { reason: 'rate_limited', url },
        );
      }
      if (response.status === 400) {
        this.throwBadRequest(body, url, overFetch);
      }
      if (response.status === 403) {
        const detail = socrataMessage(body);
        throw forbidden(
          `Socrata denied access to this resource (403)${detail ? `: ${detail}` : ''}. This is an access decision, not an outage — the same request will keep failing.`,
          { reason: 'access_denied', url },
        );
      }
      /**
       * 5xx is the only band left that maps to a reason — `upstream_error` is the one
       * retryable reason, and a server error is the one thing worth retrying. Every other
       * status (401, 410, 451, …) is thrown without a reason on purpose: the framework's
       * status-to-code classification is more accurate than any single reason string, and
       * a reason no contract declares would be re-dispatched by the callers' catch blocks
       * into an InternalError whose data carries their declared-reason list to the client.
       * With no reason the callers rethrow this error unchanged.
       */
      throw await httpErrorFromResponse(response, {
        service: 'Socrata',
        captureBody: false,
        data: {
          ...(response.status >= 500 ? { reason: 'upstream_error' } : {}),
          url,
          body: body.slice(0, 500),
        },
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (err) {
      throw serviceUnavailable(
        `Socrata answered HTTP ${response.status} with a body that is not JSON — typically an HTML error page or a response cut off mid-transfer.`,
        { reason: 'upstream_error', url },
        { cause: err },
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw serviceUnavailable(
        `Socrata answered HTTP ${response.status} with JSON in a shape this server does not recognize, so the response could not be read.`,
        { reason: 'upstream_error', url },
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

let _service: SocrataService | undefined;

export function initSocrataService(): void {
  _service = new SocrataService();
}

export function getSocrataService(): SocrataService {
  if (!_service)
    throw serviceUnavailable(
      'SocrataService not initialized — call initSocrataService() in setup()',
    );
  return _service;
}
