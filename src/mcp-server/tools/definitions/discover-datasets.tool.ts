/**
 * @fileoverview Tool to search the CDC dataset catalog by keyword, category, or tag.
 * @module mcp-server/tools/definitions/discover-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import {
  CATALOG_ASSET_TYPES,
  CDC_SOCRATA_DOMAINS,
  type DiscoverResult,
  REQUEST_TIMEOUT_TEXT,
  type SocrataDomain,
  type VocabularyTerm,
} from '@/services/socrata/types.js';
import { escapeMarkdownText, markdownBlockquote, markdownCodeSpan } from '@/utils/markdown.js';
import {
  DATASET_DESCRIPTION_CAP_TEXT,
  nonBlank,
  toPlainText,
  truncatePlainText,
} from '@/utils/text.js';
import { matchVocabulary } from '@/utils/vocabulary.js';

/**
 * Max characters of a dataset description carried in discovery output before truncation.
 * The budget is spent on visible text: markup comes off first, so a description that opens
 * with a styled block does not hand its whole allowance to tags and inline CSS.
 */
const DESCRIPTION_MAX = 300;
/** Max column field names listed in the discovery sample. */
const COLUMN_SAMPLE_MAX = 8;
/**
 * Socrata's Discovery API rejects a request with a nonzero `offset` whose `offset + limit`
 * exceeds this ceiling, with a 400 pointing at its deep-scrolling API; at `offset=0` it
 * answers any `limit` (measured live: `limit=50000` returns 200). Both CDC portals hold far
 * fewer entries than this, so the ceiling is unreachable by legitimate paging and every
 * request that crosses it is a caller error worth catching before the round trip. It also
 * bounds `limit`, which no page can usefully exceed.
 */
const CATALOG_PAGE_WINDOW_MAX = 10_000;
/**
 * Vocabulary values named per dimension when a filter matched nothing. Three keeps the
 * notice readable while covering the case where several values share a stem — "Vaccination"
 * is close to "Vaccinations", "Child Vaccinations", and "Flu Vaccinations".
 */
const NEAR_MISS_MAX = 3;

/** `"Vaccinations" (89 datasets), "Child Vaccinations" (15 datasets)` */
function renderTerms(terms: VocabularyTerm[]): string {
  return terms.map((t) => `"${t.value}" (${t.datasetCount} datasets)`).join(', ');
}

/**
 * Notice segments naming the vocabulary values closest to a filter that matched nothing.
 *
 * Only the dimensions the caller actually filtered on are fetched, so a category near miss
 * does not also pull the ~1,600-value tag vocabulary. The catalog matches `category` and
 * `tags` against its own controlled vocabulary, so a near miss is the answer to an empty
 * page — telling the caller to broaden their terms sends them after a problem that does not
 * exist. Matching is containment, not correction: a genuine typo resolves to nothing and the
 * caller is pointed at cdc_list_catalog_vocabulary instead.
 */
async function nearMissSegments(
  domain: SocrataDomain,
  category: string | undefined,
  tags: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const service = getSocrataService();
  const none = Promise.resolve<VocabularyTerm[]>([]);
  const [categoryTerms, tagTerms] = await Promise.all([
    category ? service.listCategories(domain, signal) : none,
    tags?.length ? service.listTags(domain, signal) : none,
  ]);

  const segments: string[] = [];
  const categoryHits = category ? matchVocabulary(categoryTerms, category, NEAR_MISS_MAX) : [];
  if (categoryHits.length > 0) {
    segments.push(
      `Closest category values in the catalog vocabulary: ${renderTerms(categoryHits)}.`,
    );
  }

  // Tags union, so every supplied value is resolved; the same value can surface from two of
  // them, and the ranking is rebuilt across the merged set rather than per input tag.
  const byValue = new Map<string, VocabularyTerm>();
  for (const tag of tags ?? []) {
    for (const hit of matchVocabulary(tagTerms, tag, NEAR_MISS_MAX)) byValue.set(hit.value, hit);
  }
  const tagHits = [...byValue.values()]
    .sort((a, b) => b.datasetCount - a.datasetCount)
    .slice(0, NEAR_MISS_MAX);
  if (tagHits.length > 0) {
    segments.push(`Closest tag values in the catalog vocabulary: ${renderTerms(tagHits)}.`);
  }

  return segments;
}

const AppliedFiltersSchema = z.object({
  query: z.string().optional().describe('Search query used.'),
  category: z.string().optional().describe('Category filter used.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tag filters used — a dataset matched when it carried any one of them.'),
  assetTypes: z
    .array(z.enum(CATALOG_ASSET_TYPES))
    .optional()
    .describe(
      'Asset types the search was limited to — an entry matched when it was any one of them.',
    ),
});

export const discoverDatasets = tool('cdc_discover_datasets', {
  description:
    'Search the CDC dataset catalog by keyword, category, tag, or asset type. Returns IDs, names, truncated descriptions, asset types, column counts, update timestamps, and portal links. The catalog also holds charts, maps, stories, files, and links; an entry whose columnCount is 0 is one of those and yields no data from the other tools — reach a file or link through its permalink or accessPoints, and a chart or map through the dataset its parentIds name. Use cdc_get_dataset_schema for the full column list of a chosen dataset.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Socrata API returns 429 Too Many Requests.',
      retryable: true,
      recovery: 'Retry after a brief delay; the request was rate-limited.',
    },
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Socrata returned 404 for the catalog endpoint itself — the Discovery API address is wrong or the service moved.',
      recovery:
        'Check that CDC_CATALOG_URL still points at the Socrata Discovery API; the default is https://api.us.socrata.com/api/catalog/v1.',
    },
    {
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Socrata returned 403 — the catalog refused this request rather than failing to serve it.',
      recovery:
        'Do not retry the same request; drop any category or tag filters and search with query alone.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: `Socrata catalog API returned a 5xx server error, could not be reached, did not finish answering within ${REQUEST_TIMEOUT_TEXT}, or answered with a body that is not the JSON it serves.`,
      retryable: true,
      recovery: 'Retry after a brief delay; the catalog may be temporarily unavailable.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `offset is above 0 and offset plus limit exceeds ${CATALOG_PAGE_WINDOW_MAX}, which Socrata's catalog rejects outright.`,
      recovery: `Lower offset or limit so their sum is at most ${CATALOG_PAGE_WINDOW_MAX}. Each portal holds well under two thousand entries, so a much smaller offset already reaches the end, and offset 0 takes any limit.`,
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Catalog API returned 400 — typically a malformed query or invalid filter value.',
      recovery:
        'Check that category names and tag values match what the catalog accepts; try removing filters to confirm basic discovery works.',
    },
  ],

  input: z.object({
    domain: z
      .enum(CDC_SOCRATA_DOMAINS)
      .default('data.cdc.gov')
      .describe(
        'CDC Socrata host to search. "data.cdc.gov" (default) and "chronicdata.cdc.gov" front the same catalog and return the same entries, so switching hosts neither widens nor narrows a search — chronic-disease and small-area collections such as PLACES, the Heart Disease & Stroke Atlas, and Environmental Public Health Tracking are found from either.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search across dataset names and descriptions (e.g., "diabetes mortality", "lead exposure children").',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Filter by domain category (e.g., "NNDSS", "Vaccinations", "Behavioral Risk Factors"). Values come from the catalog\'s own vocabulary and are matched exactly, ignoring case — "Vaccinations" and "vaccinations" each match 89 entries while "Vaccination" matches none. Call cdc_list_catalog_vocabulary for every value with its entry count rather than guessing at one.',
      ),
    tags: z
      .array(z.string().describe('Tag value'))
      .optional()
      .describe(
        'Filter by domain tags (e.g., ["covid19", "surveillance"]). Tags widen the search instead of narrowing it — a dataset matches when it carries any one of them, so every tag added returns more results, and an unrecognized tag matches nothing and leaves the result set unchanged. Values match the catalog\'s own tag vocabulary, case-insensitively; call cdc_list_catalog_vocabulary for the values in use with their entry counts, or read the tags field on any result. To narrow, combine tags with query or category, which intersect with the tag set.',
      ),
    asset_types: z
      .array(z.enum(CATALOG_ASSET_TYPES))
      .optional()
      .describe(
        'Limit the search to these catalog asset types, spelled as assetType reports them. An entry matches when it is any one of them, and totalCount counts only those; ["dataset", "filter"] returns just the entries with rows to query. Omitted or [] searches every type.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(CATALOG_PAGE_WINDOW_MAX)
      .default(10)
      .describe(
        `Results to return (default 10, max ${CATALOG_PAGE_WINDOW_MAX.toLocaleString('en-US')}). offset plus limit must not exceed ${CATALOG_PAGE_WINDOW_MAX}.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(9999)
      .default(0)
      .describe(
        `Pagination offset for browsing beyond first page (max 9999). offset plus limit must not exceed ${CATALOG_PAGE_WINDOW_MAX}; both CDC portals hold well under two thousand entries, so offsets near that ceiling page past the end of the catalog.`,
      ),
    order: z
      .enum(['dataset_id', 'relevance'])
      .optional()
      .describe(
        'Result ordering. Defaults to "relevance" when query is set and to "dataset_id" otherwise, at every offset; an explicit value always wins. "relevance" ranks the best matches for the query first, but its order varies between calls, so paging a relevance search by offset can repeat or skip entries. "dataset_id" sorts by each entry\'s catalog ID — a stable order whose offset pages walk every match exactly once.',
      ),
  }),

  output: z.object({
    datasets: z
      .array(
        z
          .object({
            id: z.string().describe('Four-by-four dataset identifier (e.g., "bi63-dtpu").'),
            name: z
              .string()
              .describe(
                'Dataset display name from the catalog (e.g., "Provisional COVID-19 Deaths by Sex and Age").',
              ),
            description: z
              .string()
              .optional()
              .describe(
                `Dataset description when provided by the catalog, as plain text — markup stripped and entity references decoded — then truncated to ${DESCRIPTION_MAX} characters, so the limit bounds visible text. Fetch the full text via cdc_get_dataset_schema with full_description: true; without it, that tool caps the description at ${DATASET_DESCRIPTION_CAP_TEXT} characters.`,
              ),
            assetType: z
              .string()
              .optional()
              .describe(
                'Catalog asset type as Socrata reports it — "dataset", "filter", "chart", "map", "story", "file", or "href" — and the value asset_types takes. Descriptive only: "filter" entries carry real columns and query normally, while "chart" and "map" entries do not. Read columnCount, not this field, to decide whether an entry is queryable.',
              ),
            permalink: z
              .string()
              .optional()
              .describe(
                "The entry's page on the CDC portal. For a link (href) entry it is a catalog landing page; the destination itself is in accessPoints.",
              ),
            accessPoints: z
              .array(
                z
                  .object({
                    label: z
                      .string()
                      .describe(
                        'Label the publisher gave the URL — free text, e.g. "html", "map-server".',
                      ),
                    url: z.string().describe('The URL.'),
                  })
                  .describe('One publisher-labelled URL.'),
              )
              .optional()
              .describe(
                "The URLs a link (href) entry points to, each with its publisher's label, in catalog order — the only place a link entry's destination appears. Absent when the catalog lists none.",
              ),
            parentIds: z
              .array(z.string())
              .optional()
              .describe(
                'Four-by-four IDs of the datasets this entry is built on — every chart, map, and filter names one, and a story can name several. A chart or map has no rows of its own; cdc_get_dataset_schema and cdc_query_dataset read its parent. Absent on an entry built on no other dataset.',
              ),
            category: z.string().optional().describe('Domain category when provided.'),
            tags: z.array(z.string()).optional().describe('Domain tags when provided.'),
            columnCount: z
              .number()
              .optional()
              .describe(
                'Number of columns in the dataset when reported by the catalog. A count of 0 means the entry is not tabular — cdc_get_dataset_schema and cdc_query_dataset return no usable data for it.',
              ),
            columnSample: z
              .array(z.string())
              .optional()
              .describe(
                `First ${COLUMN_SAMPLE_MAX} column field names as a preview. Call cdc_get_dataset_schema for the full column list with data types.`,
              ),
            updatedAt: z.string().optional().describe('Last data update timestamp when provided.'),
            pageViews: z.number().optional().describe('Total page views when provided.'),
          })
          .describe('A single dataset catalog entry.'),
      )
      .describe('Matching datasets.'),
  }),

  // Agent-facing result-set context: total for pagination, the filters as the server
  // applied them, and a recovery notice when nothing matched. Reaches structuredContent
  // AND content[] automatically — no format() entry needed or allowed.
  enrichment: {
    totalCount: z.number().describe('Total matching datasets in the catalog (for pagination).'),
    appliedFilters: AppliedFiltersSchema.describe(
      'Filters applied to this query; absent fields indicate no filter on that dimension. Query, category, tags, and asset types intersect with each other, but multiple tags union, as do multiple asset types.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page came back empty — the catalog values closest to a category or tag filter that matched nothing, each with its entry count; how to broaden a search when no value is close; or the size of the result set when the offset ran past its end. On a relevance-ordered page with matches remaining past it, also that relevance order varies between calls, so offset paging can repeat or skip entries, and that order: "dataset_id" walks every match.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Matching' },
    appliedFilters: {
      render: (f) => {
        const parts: string[] = [];
        if (f.query) parts.push(`- **Query:** "${escapeMarkdownText(f.query)}"`);
        if (f.category) parts.push(`- **Category:** "${escapeMarkdownText(f.category)}"`);
        if (f.tags?.length) {
          parts.push(`- **Tags (any of):** ${f.tags.map((t) => escapeMarkdownText(t)).join(', ')}`);
        }
        // Enum values, so nothing in them needs escaping.
        if (f.assetTypes?.length) {
          parts.push(`- **Asset types (any of):** ${f.assetTypes.join(', ')}`);
        }
        return parts.length > 0
          ? `**Applied Filters:**\n${parts.join('\n')}`
          : '**Applied Filters:** none';
      },
    },
    notice: { render: markdownBlockquote },
  },

  async handler(input, ctx) {
    if (input.offset + input.limit > CATALOG_PAGE_WINDOW_MAX) {
      throw ctx.fail(
        'page_out_of_range',
        `offset (${input.offset}) plus limit (${input.limit}) is ${input.offset + input.limit}, above the ${CATALOG_PAGE_WINDOW_MAX} ceiling Socrata's catalog allows for a page that starts past the first entry.`,
      );
    }

    /**
     * A whitespace-only filter is unset, as a blank one already was, and a blank tag entry is
     * dropped: none of them reaches the request, the `appliedFilters` echo, or a notice. A
     * value with text in it is kept exactly as sent.
     */
    const tags = input.tags?.filter((tag) => nonBlank(tag));
    const query = nonBlank(input.query);
    /**
     * A keyword search wants its best match on the first page; a walk of the catalog wants a
     * stable order. The default never depends on `offset`: page 2 read under a different order
     * than page 1 is neither walk.
     */
    const order = input.order ?? (query ? 'relevance' : 'dataset_id');
    // A repeated type collapses here, so the request and the echo name it once.
    const assetTypes = input.asset_types?.length ? [...new Set(input.asset_types)] : undefined;
    const filters = {
      ...input,
      query,
      category: nonBlank(input.category),
      tags: tags?.length ? tags : undefined,
      order,
      assetTypes,
    };

    const service = getSocrataService();
    let result: DiscoverResult;
    try {
      result = await service.discover(filters, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message);
      }
      throw err;
    }

    const appliedFilters = {
      ...(filters.query ? { query: filters.query } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.tags ? { tags: filters.tags } : {}),
      ...(filters.assetTypes ? { assetTypes: filters.assetTypes } : {}),
    };

    ctx.enrich({ totalCount: result.totalCount, appliedFilters });

    /**
     * Guidance accumulates here and is flushed through a single `ctx.enrich.notice` call:
     * `notice` is last-wins, so a second writer would silently destroy the first message.
     */
    const segments: string[] = [];

    if (result.datasets.length === 0) {
      const filterParts: string[] = [];
      if (filters.query) filterParts.push(`query "${filters.query}"`);
      if (filters.category) filterParts.push(`category "${filters.category}"`);
      if (filters.tags) filterParts.push(`any of tags [${filters.tags.join(', ')}]`);
      if (filters.assetTypes) {
        filterParts.push(`asset types [${filters.assetTypes.join(', ')}]`);
      }
      const criteria = filterParts.length > 0 ? ` for ${filterParts.join(', ')}` : '';

      /**
       * An offset at or past totalCount empties the page even though the search itself
       * matched. Suggesting broader terms there sends the caller after a problem that
       * does not exist — name the exhausted page instead.
       */
      if (result.totalCount > 0 && input.offset >= result.totalCount) {
        segments.push(
          `Offset ${input.offset} is past the end of the result set${criteria}, which holds ${result.totalCount} datasets. The search itself matched — lower offset to below ${result.totalCount} to see results.`,
        );
      } else {
        /**
         * The only branch that reaches the vocabulary endpoints, and only when a vocabulary
         * filter was in play: an ordinary search, a non-empty page, and an exhausted page all
         * cost nothing extra. The lookup annotates an answer that is already correct, so an
         * upstream failure of it is absorbed rather than allowed to fail a discovery that
         * already succeeded. The caller cancelling is the call ending, not the lookup failing.
         */
        const wantsNearMiss = Boolean(filters.category || filters.tags);
        let nearMiss: string[] = [];
        if (wantsNearMiss) {
          try {
            nearMiss = await nearMissSegments(
              input.domain,
              filters.category,
              filters.tags,
              ctx.signal,
            );
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            ctx.log.debug('Near-miss vocabulary lookup failed', { domain: input.domain });
          }
        }

        segments.push(`No datasets found${criteria}.`);
        if (nearMiss.length > 0) {
          segments.push(
            ...nearMiss,
            'Pass one exactly as spelled, or call cdc_list_catalog_vocabulary for every value with its entry count.',
          );
        } else {
          segments.push(
            'Try broader search terms, different keywords, or remove category/tag filters. Browse all datasets by calling with no parameters.',
          );
          /**
           * Tags union, so an empty page under a tag filter means no dataset carries any of
           * them — a misspelled tag is indistinguishable from a real one that matched nothing.
           */
          if (filters.tags) {
            segments.push(
              'Tags match the catalog vocabulary rather than free text, so a tag no dataset carries contributes nothing.',
            );
          }
          if (wantsNearMiss) {
            segments.push(
              "Category and tag values come from the catalog's own vocabulary — call cdc_list_catalog_vocabulary to see them with their entry counts.",
            );
          }
        }
        if (filters.assetTypes) {
          segments.push(
            'asset_types kept only entries of the listed types; omit it to search every type.',
          );
        }
      }
    }

    /**
     * Relevance order differs between identical calls, not only across pages, so an offset walk
     * under it repeats and skips entries. Said only while matches remain past this page — a page
     * that reaches the last match has nothing left to walk.
     */
    if (order === 'relevance' && result.totalCount > input.offset + result.datasets.length) {
      segments.push(
        `Results are ranked by relevance, which varies between calls, so paging this search by offset can repeat or skip entries. Pass order: "dataset_id" to walk all ${result.totalCount} matches in a stable order.`,
      );
    }

    if (segments.length > 0) ctx.enrich.notice(segments.join(' '));

    ctx.log.info('Dataset discovery completed', {
      domain: input.domain,
      order,
      query: filters.query,
      category: filters.category,
      resultCount: result.datasets.length,
      totalCount: result.totalCount,
    });

    const datasets = result.datasets.map((d) => {
      /**
       * Converted to plain text before the cut, never after: markup left in place spends the
       * budget on tags and puts the ellipsis before the first word about the dataset. A
       * description that is markup all the way down renders to nothing — omit it rather than
       * shipping an empty string as if the catalog had supplied one.
       */
      const description = d.description
        ? truncatePlainText(toPlainText(d.description), DESCRIPTION_MAX)
        : '';
      return {
        id: d.id,
        name: d.name,
        ...(d.assetType ? { assetType: d.assetType } : {}),
        ...(d.permalink ? { permalink: d.permalink } : {}),
        ...(d.accessPoints ? { accessPoints: d.accessPoints } : {}),
        ...(d.parentIds ? { parentIds: d.parentIds } : {}),
        ...(description ? { description } : {}),
        ...(d.category ? { category: d.category } : {}),
        ...(d.tags ? { tags: d.tags } : {}),
        ...(d.columnNames
          ? {
              columnCount: d.columnNames.length,
              columnSample: d.columnNames.slice(0, COLUMN_SAMPLE_MAX),
            }
          : {}),
        ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
        ...(typeof d.pageViews === 'number' ? { pageViews: d.pageViews } : {}),
      };
    });

    return { datasets };
  },

  format: (result) => {
    if (result.datasets.length === 0) {
      return [
        {
          type: 'text',
          text: 'No datasets matched the search criteria.',
        },
      ];
    }

    // Every string below except the server's own labels comes from the catalog, so each one
    // goes through the escaper for the slot it sits in.
    const field = (value: string | undefined) => (value ? escapeMarkdownText(value) : '—');
    const lines: string[] = [`**${result.datasets.length} datasets returned**\n`];
    for (const d of result.datasets) {
      lines.push(`### ${escapeMarkdownText(d.name, 'heading')}`);
      const views = typeof d.pageViews === 'number' ? d.pageViews.toLocaleString() : '—';
      lines.push(
        `**ID:** ${markdownCodeSpan(d.id)} | **Type:** ${field(d.assetType)} | **Category:** ${field(d.category)} | **Updated:** ${field(d.updatedAt)} | **Views:** ${views}`,
      );
      if (d.description) lines.push(escapeMarkdownText(d.description, 'line'));
      if (d.tags && d.tags.length > 0) {
        lines.push(`**Tags:** ${d.tags.map((t) => escapeMarkdownText(t)).join(', ')}`);
      }
      if (d.columnCount === 0) {
        lines.push(
          '**Columns:** none — not a tabular asset; cdc_get_dataset_schema and cdc_query_dataset return no data for this ID.',
        );
      } else if (typeof d.columnCount === 'number') {
        const sample = d.columnSample?.map(markdownCodeSpan).join(', ');
        const preview =
          sample && d.columnCount > (d.columnSample?.length ?? 0)
            ? ` (e.g. ${sample}, …)`
            : sample
              ? ` (${sample})`
              : '';
        lines.push(`**Columns:** ${d.columnCount}${preview}`);
      }
      if (d.permalink) lines.push(`**Permalink:** ${escapeMarkdownText(d.permalink)}`);
      if (d.parentIds?.length) {
        lines.push(`**Built on:** ${d.parentIds.map(markdownCodeSpan).join(', ')}`);
      }
      /**
       * Last in the entry: a line after a list item would continue that item. A label opens its
       * item's content, where a leading marker would start a nested block, so it takes the `line`
       * slot.
       */
      if (d.accessPoints?.length) {
        lines.push(
          '**Access points:**',
          ...d.accessPoints.map(
            (p) => `- ${escapeMarkdownText(p.label, 'line')}: ${escapeMarkdownText(p.url)}`,
          ),
        );
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
