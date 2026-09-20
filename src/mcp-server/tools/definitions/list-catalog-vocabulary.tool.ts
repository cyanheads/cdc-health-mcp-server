/**
 * @fileoverview Tool to list the CDC catalog's category and tag vocabularies with entry counts.
 * @module mcp-server/tools/definitions/list-catalog-vocabulary
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import { CDC_SOCRATA_DOMAINS, type VocabularyTerm } from '@/services/socrata/types.js';
import { escapeTableCell } from '@/utils/markdown.js';
import { isDiscriminatingFilter, MIN_FILTER_LENGTH, matchVocabulary } from '@/utils/vocabulary.js';

/**
 * Tags returned per call when the caller names no window. The tag vocabulary is a long tail:
 * of the 1,583 values on `data.cdc.gov`, 33 carry 50 or more catalog entries and 637 carry
 * exactly one. A count-ranked page of 50 reaches down to around 39 entries — the part of the
 * distribution a caller is choosing a filter from — for roughly 3 KB, where the whole set
 * costs about 66 KB of structuredContent and 36 KB of rendered text in a single response.
 */
const DEFAULT_TAG_LIMIT = 50;
/** Ceiling on `tag_limit`, enough to pull the whole useful head of the distribution at once. */
const MAX_TAG_LIMIT = 500;

const VocabularyTermSchema = z
  .object({
    value: z
      .string()
      .describe(
        'The value as the catalog spells it — pass it verbatim to cdc_discover_datasets. Categories are matched case-sensitively by the catalog; tags case-insensitively.',
      ),
    datasetCount: z
      .number()
      .describe(
        'Catalog entries carrying this value. Charts, maps, stories, files, and links are counted alongside datasets, so this is an upper bound on the queryable entries a filter returns.',
      ),
  })
  .describe('One vocabulary value with its catalog entry count.');

export const listCatalogVocabulary = tool('cdc_list_catalog_vocabulary', {
  title: 'List CDC Catalog Vocabulary',
  description:
    "List the controlled vocabularies cdc_discover_datasets' category and tags filters are matched against — every domain category and domain tag the CDC catalog publishes, each with the number of entries carrying it. Call it before filtering a search: a value the catalog does not carry matches nothing and returns an empty page, which is indistinguishable from a real value with no results. All 55 categories come back whole; the tag vocabulary runs to roughly 1,600 values, so tags are ranked by entry count and returned one page at a time via tag_limit and tag_offset. Pass filter to narrow both vocabularies to the values whose words contain it.",
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
      when: 'Socrata returned 404 for the vocabulary endpoint itself — the Discovery API address is wrong or the service moved.',
      recovery:
        'Check that CDC_CATALOG_URL still points at the Socrata Discovery API; the default is https://api.us.socrata.com/api/catalog/v1.',
    },
    {
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Socrata returned 403 — the catalog refused this request rather than failing to serve it.',
      recovery:
        'Do not repeat this request; read the category and tag values off the results of cdc_discover_datasets instead.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Socrata catalog API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a brief delay; the catalog may be temporarily unavailable.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Socrata rejected the vocabulary request with a 400.',
      recovery:
        'Read the returned message for the rejected part; the request carries only the domain, so a rejection points at CDC_CATALOG_URL rather than at any input.',
    },
  ],

  input: z.object({
    domain: z
      .enum(CDC_SOCRATA_DOMAINS)
      .default('data.cdc.gov')
      .describe(
        'CDC Socrata host to read the vocabulary from. "data.cdc.gov" (default) and "chronicdata.cdc.gov" front the same catalog and publish the same vocabulary, so this selects which host answers, never which values exist.',
      ),
    filter: z
      .string()
      .optional()
      .describe(
        'Narrow both vocabularies to the values related to this text. A value matches when every word of the filter appears inside one of its words ("vaccin" reaches "Vaccinations" and "covid-19 vaccination"), or when the whole value appears in the filter. Matching is not fuzzy — a misspelling returns nothing rather than a guess — and a filter under three letters is ignored.',
      ),
    tag_limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TAG_LIMIT)
      .default(DEFAULT_TAG_LIMIT)
      .describe(
        `Tags to return in this call (default ${DEFAULT_TAG_LIMIT}, max ${MAX_TAG_LIMIT}). Tags are ranked by entry count, so the default page is the most-used end of the vocabulary; the response reports how many matched and a nextOffset while more remain. Categories are never paged — all 55 arrive whole.`,
      ),
    tag_offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(0)
      .describe(
        'Index of the first tag to return, for continuing past a previous call (default 0). Ranking is stable, so tag_offset plus tag_limit walks the vocabulary without gaps or repeats. An offset at or past the number of matching tags returns an empty tag list rather than an error.',
      ),
  }),

  output: z.object({
    domain: z.enum(CDC_SOCRATA_DOMAINS).describe('CDC Socrata host this vocabulary was read from.'),
    categories: z
      .array(VocabularyTermSchema)
      .describe(
        "Every domain category matching the filter, ranked by entry count. Pass a value to cdc_discover_datasets' category input exactly as spelled here.",
      ),
    tags: z
      .array(VocabularyTermSchema)
      .describe(
        "The requested window of domain tags, ranked by entry count. Pass values to cdc_discover_datasets' tags input; tags union there, so each one added widens the result set.",
      ),
  }),

  // Agent-facing context on the vocabulary as a whole: how large it is, how much of it the
  // filter matched, and where the tag window sits inside that. Reaches structuredContent AND
  // content[] automatically — no format() entry needed or allowed.
  enrichment: {
    vocabularySize: z
      .object({
        categories: z.number().describe('Domain categories published for this host.'),
        tags: z.number().describe('Domain tags published for this host.'),
      })
      .describe('Size of each full vocabulary on this host, before any filter was applied.'),
    categoryCount: z
      .number()
      .describe('Categories matching the filter. Every one of them is in this response.'),
    tagCount: z.number().describe('Tags matching the filter, before tag_limit and tag_offset.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the returned tags are a subset of the matching ones. Absent means every matching tag is in this response.',
      ),
    shown: z.number().optional().describe('Number of tags returned in this response.'),
    cap: z.number().optional().describe('The tag_limit that bounded this response.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Upper bound on the entry count of every tag not returned. Tags are ranked by entry count, so no omitted tag is carried by more entries than the last one shown.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as tag_offset on the next call to continue after the last tag returned. Present only while matching tags remain.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response is a subset of the vocabulary, when a filter too short to discriminate was ignored, when the filter matched nothing, or when tag_offset ran past the end of the matches.',
      ),
  },

  enrichmentTrailer: {
    vocabularySize: {
      render: (v) => `**Vocabulary:** ${v.categories} categories · ${v.tags} tags`,
    },
    categoryCount: { label: 'Categories Matching' },
    tagCount: { label: 'Tags Matching' },
  },

  async handler(input, ctx) {
    const service = getSocrataService();
    let categories: VocabularyTerm[];
    let tags: VocabularyTerm[];
    try {
      /**
       * Both vocabularies are payload here, so neither is optional the way the live row
       * count is on the schema surfaces — `Promise.all` rejects on the first failure and the
       * contract reason travels out of the catch below.
       */
      [categories, tags] = await Promise.all([
        service.listCategories(input.domain, ctx.signal),
        service.listTags(input.domain, ctx.signal),
      ]);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

    const vocabularySize = { categories: categories.length, tags: tags.length };
    /**
     * A filter too short to discriminate matches nothing, and reporting that as "no match"
     * would send the caller after a spelling problem that does not exist. It is dropped
     * instead, so the response carries the unfiltered vocabulary and says the filter was
     * ignored. An empty string is no filter at all and needs no notice.
     */
    const ignoredFilter = !!input.filter && !isDiscriminatingFilter(input.filter);
    const filter = ignoredFilter ? undefined : input.filter;
    // Filtering runs over the complete vocabularies, never over the page — a filter applied
    // after the cut would search the 50 tags that happened to rank highest.
    const matchedCategories = filter ? matchVocabulary(categories, filter) : categories;
    const matchedTags = filter ? matchVocabulary(tags, filter) : tags;

    const page = matchedTags.slice(input.tag_offset, input.tag_offset + input.tag_limit);
    const consumed = input.tag_offset + page.length;

    ctx.enrich({
      vocabularySize,
      categoryCount: matchedCategories.length,
      tagCount: matchedTags.length,
    });

    const guidance: string[] = [];
    if (ignoredFilter) {
      guidance.push(
        `Filter "${input.filter}" was ignored: matching needs at least ${MIN_FILTER_LENGTH} letters or digits, and anything shorter is contained in most values. This response is the unfiltered vocabulary — call again with a longer filter to narrow it.`,
      );
    }

    if (filter && matchedCategories.length === 0 && matchedTags.length === 0) {
      guidance.push(
        `No category or tag matches "${filter}". Matching is exact on words rather than approximate, so a misspelling returns nothing — call again without filter to browse the ${vocabularySize.categories} categories and the most-used tags.`,
      );
    } else if (input.tag_offset >= matchedTags.length && matchedTags.length > 0) {
      guidance.push(
        `tag_offset ${input.tag_offset} is past the end of the ${matchedTags.length} matching tags. Lower tag_offset below ${matchedTags.length} to see tags.`,
      );
    } else if (consumed < matchedTags.length) {
      // Offering a bigger page to a caller already at the ceiling is advice they cannot take.
      const raise =
        input.tag_limit < MAX_TAG_LIMIT ? ` raise tag_limit (max ${MAX_TAG_LIMIT}),` : '';
      guidance.push(
        `Showing tags ${input.tag_offset + 1}–${consumed} of ${matchedTags.length}, ranked by entry count. Call again with tag_offset=${consumed} for the next page,${raise} or pass filter to narrow the vocabulary instead of paging it.`,
      );
    }

    /**
     * `enrich.truncated()` writes `notice` itself and last-wins over any other notice call,
     * so the guidance is handed to it rather than emitted separately — two writers would
     * silently destroy one of the two messages.
     */
    if (page.length < matchedTags.length) {
      const hasMore = consumed < matchedTags.length;
      const last = page.at(-1);
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.tag_limit,
        // Ranked by entry count, so the smallest count shown bounds every tag left out.
        ...(hasMore && last ? { ceiling: last.datasetCount } : {}),
        guidance: guidance.join(' '),
      });
      if (hasMore) ctx.enrich({ nextOffset: consumed });
    } else if (guidance.length > 0) {
      ctx.enrich.notice(guidance.join(' '));
    }

    ctx.log.info('Catalog vocabulary listed', {
      domain: input.domain,
      filter: input.filter,
      categoryCount: matchedCategories.length,
      tagCount: matchedTags.length,
      tagsShown: page.length,
      tagOffset: input.tag_offset,
    });

    return { domain: input.domain, categories: matchedCategories, tags: page };
  },

  format: (result) => {
    const lines = [`## CDC catalog vocabulary`, `**Domain:** ${result.domain}`, ''];

    const table = (heading: string, column: string, terms: typeof result.categories) => {
      lines.push(`### ${heading} (${terms.length})`, '');
      if (terms.length === 0) {
        lines.push('None matched.', '');
        return;
      }
      lines.push(`| ${column} | Entries |`, '|:---|---:|');
      for (const term of terms) {
        lines.push(`| ${escapeTableCell(term.value)} | ${term.datasetCount} |`);
      }
      lines.push('');
    };

    table('Categories', 'Category', result.categories);
    table('Tags', 'Tag', result.tags);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
