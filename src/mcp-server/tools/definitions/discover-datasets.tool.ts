/**
 * @fileoverview Tool to search the CDC dataset catalog by keyword, category, or tag.
 * @module mcp-server/tools/definitions/discover-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import {
  CDC_SOCRATA_DOMAINS,
  type DiscoverResult,
  type SocrataDomain,
  type VocabularyTerm,
} from '@/services/socrata/types.js';
import { toPlainText } from '@/utils/text.js';
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
 * Socrata's Discovery API rejects any request whose `offset + limit` exceeds this ceiling
 * with a 400 pointing at its deep-scrolling API. Both CDC portals hold far fewer entries
 * than this, so the ceiling is unreachable by legitimate paging and every request that
 * crosses it is a caller error worth catching before the round trip.
 */
const CATALOG_PAGE_WINDOW_MAX = 10_000;
/**
 * Vocabulary values named per dimension when a filter matched nothing. Three keeps the
 * notice readable while covering the case where several values share a stem — "Vaccination"
 * is close to "Vaccinations", "Child Vaccinations", and "Flu Vaccinations".
 */
const NEAR_MISS_MAX = 3;

/**
 * Render a catalog description as plain text, then truncate to DESCRIPTION_MAX chars with an
 * ellipsis when cut. Conversion runs before the cut, never after: markup left in place spends
 * the budget on tags and puts the ellipsis before the first word about the dataset.
 */
function truncateDescription(description: string): string {
  const text = toPlainText(description);
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX)}…` : text;
}

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
});

export const discoverDatasets = tool('cdc_discover_datasets', {
  description:
    'Search the CDC dataset catalog by keyword, category, or tag. Returns IDs, names, truncated descriptions, asset types, column counts, and update timestamps. The catalog also holds charts, maps, stories, files, and links; an entry whose columnCount is 0 is one of those and yields no data from the other tools. Use cdc_get_dataset_schema for the full column list of a chosen dataset.',
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
      when: 'Socrata catalog API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a brief delay; the catalog may be temporarily unavailable.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `offset plus limit exceeds ${CATALOG_PAGE_WINDOW_MAX}, which Socrata's catalog rejects outright.`,
      recovery: `Lower offset, limit, or both so their sum is at most ${CATALOG_PAGE_WINDOW_MAX}; each portal holds well under two thousand entries, so a much smaller offset already reaches the end.`,
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
        'Filter by domain category (e.g., "NNDSS", "Vaccinations", "Behavioral Risk Factors"). Values come from the catalog\'s own vocabulary and are matched exactly, including case — "Vaccinations" matches 89 entries while "Vaccination" matches none. Call cdc_list_catalog_vocabulary for every value with its entry count rather than guessing at one.',
      ),
    tags: z
      .array(z.string().describe('Tag value'))
      .optional()
      .describe(
        'Filter by domain tags (e.g., ["covid19", "surveillance"]). Tags widen the search instead of narrowing it — a dataset matches when it carries any one of them, so every tag added returns more results, and an unrecognized tag matches nothing and leaves the result set unchanged. Values match the catalog\'s own tag vocabulary, case-insensitively; call cdc_list_catalog_vocabulary for the values in use with their entry counts, or read the tags field on any result. To narrow, combine tags with query or category, which intersect with the tag set.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe(
        `Results to return (default 10, max 100). offset plus limit must not exceed ${CATALOG_PAGE_WINDOW_MAX}.`,
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
      .default('dataset_id')
      .describe(
        'Result ordering. "dataset_id" (default) sorts deterministically by each dataset\'s unique catalog ID — required for stable offset pagination, since consecutive pages form a gap-free, duplicate-free traversal. "relevance" returns best-match ranking for keyword search but is not stably paginable across pages, so walking offsets can skip or repeat datasets.',
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
                `Dataset description when provided by the catalog, as plain text — markup stripped and entity references decoded — then truncated to ${DESCRIPTION_MAX} characters, so the limit bounds visible text. Fetch the full text via cdc_get_dataset_schema.`,
              ),
            assetType: z
              .string()
              .optional()
              .describe(
                'Catalog asset type as Socrata reports it — "dataset", "filter", "chart", "map", "story", "file", or "href". Descriptive only: "filter" entries carry real columns and query normally, while "chart" and "map" entries do not. Read columnCount, not this field, to decide whether an entry is queryable.',
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
      'Filters applied to this query; absent fields indicate no filter on that dimension. Query, category, and tags intersect with each other, but multiple tags union.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page came back empty — the catalog values closest to a category or tag filter that matched nothing, each with its entry count; how to broaden a search when no value is close; or the size of the result set when the offset ran past its end.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Matching' },
    appliedFilters: {
      render: (f) => {
        const parts: string[] = [];
        if (f.query) parts.push(`- **Query:** "${f.query}"`);
        if (f.category) parts.push(`- **Category:** "${f.category}"`);
        if (f.tags?.length) parts.push(`- **Tags (any of):** ${f.tags.join(', ')}`);
        return parts.length > 0
          ? `**Applied Filters:**\n${parts.join('\n')}`
          : '**Applied Filters:** none';
      },
    },
  },

  async handler(input, ctx) {
    if (input.offset + input.limit > CATALOG_PAGE_WINDOW_MAX) {
      throw ctx.fail(
        'page_out_of_range',
        `offset (${input.offset}) plus limit (${input.limit}) is ${input.offset + input.limit}, above the ${CATALOG_PAGE_WINDOW_MAX} ceiling Socrata's catalog allows for a single page.`,
        { ...ctx.recoveryFor('page_out_of_range') },
      );
    }

    const service = getSocrataService();
    let result: DiscoverResult;
    try {
      result = await service.discover(input, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

    const appliedFilters = {
      ...(input.query ? { query: input.query } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
    };

    ctx.enrich({ totalCount: result.totalCount, appliedFilters });

    if (result.datasets.length === 0) {
      const filterParts: string[] = [];
      if (input.query) filterParts.push(`query "${input.query}"`);
      if (input.category) filterParts.push(`category "${input.category}"`);
      if (input.tags?.length) filterParts.push(`any of tags [${input.tags.join(', ')}]`);
      const criteria = filterParts.length > 0 ? ` for ${filterParts.join(', ')}` : '';

      /**
       * Guidance accumulates here and is flushed through a single `ctx.enrich.notice` call:
       * `notice` is last-wins, so a second writer would silently destroy the first message.
       */
      const segments: string[] = [];

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
         * cost nothing extra. The lookup annotates an answer that is already correct, so its
         * failure is absorbed rather than allowed to fail a discovery that already succeeded.
         */
        const wantsNearMiss = Boolean(input.category) || Boolean(input.tags?.length);
        let nearMiss: string[] = [];
        if (wantsNearMiss) {
          try {
            nearMiss = await nearMissSegments(input.domain, input.category, input.tags, ctx.signal);
          } catch {
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
          if (input.tags?.length) {
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
      }

      ctx.enrich.notice(segments.join(' '));
    }

    ctx.log.info('Dataset discovery completed', {
      domain: input.domain,
      query: input.query,
      category: input.category,
      resultCount: result.datasets.length,
      totalCount: result.totalCount,
    });

    const datasets = result.datasets.map((d) => {
      // A description that is markup all the way down renders to nothing — omit it rather
      // than shipping an empty string as if the catalog had supplied one.
      const description = d.description ? truncateDescription(d.description) : '';
      return {
        id: d.id,
        name: d.name,
        ...(d.assetType ? { assetType: d.assetType } : {}),
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

    const lines: string[] = [`**${result.datasets.length} datasets returned**\n`];
    for (const d of result.datasets) {
      lines.push(`### ${d.name}`);
      const views = typeof d.pageViews === 'number' ? d.pageViews.toLocaleString() : '—';
      lines.push(
        `**ID:** \`${d.id}\` | **Type:** ${d.assetType ?? '—'} | **Category:** ${d.category ?? '—'} | **Updated:** ${d.updatedAt ?? '—'} | **Views:** ${views}`,
      );
      if (d.description) lines.push(d.description);
      if (d.tags && d.tags.length > 0) lines.push(`**Tags:** ${d.tags.join(', ')}`);
      if (d.columnCount === 0) {
        lines.push(
          '**Columns:** none — not a tabular asset; cdc_get_dataset_schema and cdc_query_dataset return no data for this ID.',
        );
      } else if (typeof d.columnCount === 'number') {
        const sample = d.columnSample?.map((name) => `\`${name}\``).join(', ');
        const preview =
          sample && d.columnCount > (d.columnSample?.length ?? 0)
            ? ` (e.g. ${sample}, …)`
            : sample
              ? ` (${sample})`
              : '';
        lines.push(`**Columns:** ${d.columnCount}${preview}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
