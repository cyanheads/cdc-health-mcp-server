/**
 * @fileoverview Socrata SODA API client for CDC Open Data portal.
 * Handles discovery, metadata, and SoQL queries with rate-limit-aware request spacing.
 * Failed responses are classified by status into distinct contract reasons so callers can
 * tell a permanent access decision (403) from a transient upstream outage (5xx).
 * @module services/socrata/socrata-service
 */

import {
  forbidden,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { toPlainText } from '@/utils/text.js';
import type {
  CatalogDataset,
  DatasetColumn,
  DatasetMetadata,
  DiscoverResult,
  QueryResult,
  SocrataDomain,
  VocabularyTerm,
} from './types.js';

const MIN_REQUEST_INTERVAL_MS = 250;

/**
 * Explicit page size for the tag vocabulary. `domain_tags` answers a request that names no
 * limit with 100 values and reports `resultSetSize: 100` beside them, so the response looks
 * complete at a hundredth of the vocabulary and nothing in it says otherwise. Measured live,
 * `data.cdc.gov` carries 1,583 tags and a larger limit returns the same 1,583 — so this
 * value reaches the whole set rather than trading one silent cap for another.
 */
const TAG_VOCABULARY_LIMIT = 10_000;

/**
 * Deadline on the live row count, which annotates a metadata response that has usually
 * already arrived. Without a bound of its own, a stalled count would hold that response open
 * indefinitely — turning an optional annotation into a hang of the answer it decorates.
 * Measured live, the request returns in well under a second.
 */
const ROW_COUNT_TIMEOUT_MS = 5_000;

/** Options for discovering datasets. */
export interface DiscoverOptions {
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

/**
 * Strip the trailing Scala `; position: Map(...)` debug dump that Socrata appends
 * to SoQL error messages — noise for an agent acting on the error.
 */
function stripPositionTail(message: string): string {
  return message.replace(/;\s*position:\s*Map\([\s\S]*$/, '').trimEnd();
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

    if (options.query) params.set('q', options.query);
    if (options.category) params.set('categories', options.category);
    if (options.tags) {
      for (const tag of options.tags) params.append('tags', tag);
    }
    params.set('limit', String(options.limit ?? 10));
    params.set('offset', String(options.offset ?? 0));
    if (options.order) params.set('order', options.order);

    const url = `${config.catalogUrl}?${params}`;
    const data = await this.fetchJson(url, signal);

    const results = (data.results ?? []) as Record<string, unknown>[];
    const datasets: CatalogDataset[] = results.map((r) => {
      const resource = r.resource as Record<string, unknown>;
      const classification = r.classification as Record<string, unknown> | undefined;
      const description = resource.description as string | undefined;
      const category = classification?.domain_category as string | undefined;
      const tags = classification?.domain_tags as string[] | undefined;
      const columnNames = resource.columns_field_name as string[] | undefined;
      const columnTypes = resource.columns_datatype as string[] | undefined;
      const updatedAt = resource.data_updated_at as string | undefined;
      const assetType = resource.type as string | undefined;
      const pageViews = (resource.page_views as Record<string, number> | undefined)
        ?.page_views_total;
      return {
        id: resource.id as string,
        name: resource.name as string,
        ...(assetType ? { assetType } : {}),
        ...(description ? { description } : {}),
        ...(category ? { category } : {}),
        ...(tags ? { tags } : {}),
        ...(columnNames ? { columnNames } : {}),
        ...(columnTypes ? { columnTypes } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(typeof pageViews === 'number' ? { pageViews } : {}),
      };
    });

    return { datasets, totalCount: (data.resultSetSize as number) ?? 0 };
  }

  /**
   * Every value in the catalog's category vocabulary for a domain, ranked by entry count.
   *
   * The whole vocabulary arrives in one request: `domain_categories` answers with 55 values
   * for both CDC hosts and reports the same figure as `resultSetSize`, well inside any page
   * size the endpoint applies.
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
    const data = await this.fetchJson(`${getServerConfig().catalogUrl}/${path}?${params}`, signal);

    const terms: VocabularyTerm[] = [];
    for (const row of (data.results ?? []) as Record<string, unknown>[]) {
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
   * `rowCountSource` naming which figure is in hand.
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
    const data = await this.fetchJson(url, signal);

    const rawColumns = (data.columns as Record<string, unknown>[]) ?? [];
    const columns: DatasetColumn[] = rawColumns.map((col) => {
      const description = col.description as string | undefined;
      return {
        fieldName: (col.fieldName as string) ?? '',
        dataType: (col.dataTypeName as string) ?? '',
        ...(description ? { description } : {}),
      };
    });

    const firstColCache = rawColumns[0]?.cachedContents as Record<string, unknown> | undefined;
    const rawCount = firstColCache?.count;
    const rowCount = rawCount != null ? Number(rawCount) : Number.NaN;
    const rowsUpdatedAt = data.rowsUpdatedAt as number | undefined;
    const updatedAt =
      typeof rowsUpdatedAt === 'number' ? new Date(rowsUpdatedAt * 1000).toISOString() : undefined;
    const description = toPlainText((data.description as string | undefined) ?? '');

    return {
      name: (data.name as string) ?? '',
      columns,
      ...(description ? { description } : {}),
      ...(Number.isFinite(rowCount) ? { rowCount, rowCountSource: 'cached' as const } : {}),
      ...(updatedAt ? { updatedAt } : {}),
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
   * The request runs under its own deadline on top of the caller's signal, and is cancelled
   * when either fires — see `ROW_COUNT_TIMEOUT_MS`.
   */
  private async countRows(
    datasetId: string,
    signal: AbortSignal | undefined,
    domain: SocrataDomain | undefined,
  ): Promise<number | undefined> {
    const url = `${this.baseUrlFor(domain)}/resource/${datasetId}.json?${new URLSearchParams({
      $select: 'count(*)',
    })}`;

    const deadline = new AbortController();
    const abort = () => deadline.abort();
    const timer = setTimeout(abort, ROW_COUNT_TIMEOUT_MS);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort);

    try {
      const rows = await this.fetchJson<Record<string, unknown>[]>(url, deadline.signal);
      const [value] = Object.values(rows[0] ?? {});
      const count = Number(value);
      return Number.isInteger(count) && count >= 0 ? count : undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Execute a SoQL query against a CDC dataset.
   *
   * The wire request asks for one row more than the caller's limit. The SODA data endpoint
   * reports no total, so that extra row is the only evidence that separates a result set
   * whose last page happens to fill the limit from one that was cut short. It is dropped
   * before returning and recorded as `hasMore`; the echoed `query` keeps the caller's own
   * `$limit` so it can be replayed without inheriting the probe.
   */
  async query(options: QueryOptions, signal?: AbortSignal): Promise<QueryResult> {
    const params = new URLSearchParams();
    const limit = options.limit ?? 100;

    if (options.search) params.set('$q', options.search);
    if (options.select) params.set('$select', options.select);
    if (options.where) params.set('$where', options.where);
    if (options.group) params.set('$group', options.group);
    if (options.having) params.set('$having', options.having);
    if (options.order) params.set('$order', options.order);
    params.set('$limit', String(limit));
    params.set('$offset', String(options.offset ?? 0));

    const query = decodedQueryString(params);
    params.set('$limit', String(limit + 1));

    const url = `${this.baseUrlFor(options.domain)}/resource/${options.datasetId}.json?${params}`;
    const fetched = await this.fetchJson<Record<string, unknown>[]>(url, signal);

    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;

    return { rows, rowCount: rows.length, query, hasMore };
  }

  private throwBadRequest(body: string, url: string): never {
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
    const rawMessage = (parsed?.message ?? parsed?.error) as string | undefined;

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

  private async fetchJson<T = Record<string, unknown>>(
    url: string,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.throttle();
    const config = getServerConfig();

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.appToken) headers['X-App-Token'] = config.appToken;

    const response = await globalThis.fetch(url, {
      headers,
      signal: signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
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
        this.throwBadRequest(body, url);
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

    return (await response.json()) as T;
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
