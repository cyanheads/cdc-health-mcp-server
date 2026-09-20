/**
 * @fileoverview Tests for cdc_list_catalog_vocabulary tool.
 * @module tests/mcp-server/tools/definitions/list-catalog-vocabulary
 */

import {
  forbidden,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCatalogVocabulary } from '@/mcp-server/tools/definitions/list-catalog-vocabulary.tool.js';
import type { VocabularyTerm } from '@/services/socrata/types.js';

const mockListCategories = vi.fn<() => Promise<VocabularyTerm[]>>();
const mockListTags = vi.fn<() => Promise<VocabularyTerm[]>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ listCategories: mockListCategories, listTags: mockListTags }),
}));

/** Live `data.cdc.gov` values, count-ranked as the service returns them. */
const CATEGORIES: VocabularyTerm[] = [
  { value: 'NNDSS', datasetCount: 295 },
  { value: 'National Center for Health Statistics', datasetCount: 287 },
  { value: 'Vaccinations', datasetCount: 89 },
  { value: 'Motor Vehicle', datasetCount: 45 },
  { value: 'Child Vaccinations', datasetCount: 15 },
];

/** Long enough to page: the tail is the part a default-sized response leaves out. */
const TAGS: VocabularyTerm[] = [
  { value: 'nndss', datasetCount: 294 },
  { value: 'covid-19', datasetCount: 176 },
  { value: 'vaccination', datasetCount: 41 },
  { value: 'covid-19 vaccination', datasetCount: 35 },
  { value: 'flu vaccination', datasetCount: 28 },
  { value: 'zoster', datasetCount: 1 },
];

const text = (blocks: ReturnType<NonNullable<typeof listCatalogVocabulary.format>>) =>
  (blocks[0] as { type: 'text'; text: string }).text;

describe('cdc_list_catalog_vocabulary', () => {
  beforeEach(() => {
    mockListCategories.mockResolvedValue(CATEGORIES);
    mockListTags.mockResolvedValue(TAGS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('both client surfaces', () => {
    it('carries every value and count in structuredContent', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({}),
        ctx,
      );

      /**
       * Read through the output schema rather than off the raw handler return: the framework
       * parses the result against `output` before it reaches structuredContent, so a field
       * the schema does not declare is stripped on the way out whatever the handler built.
       */
      const wire = listCatalogVocabulary.output.parse(result);
      expect(wire.domain).toBe('data.cdc.gov');
      expect(wire.categories).toEqual(CATEGORIES);
      expect(wire.tags).toEqual(TAGS);
      expect(wire.categories.length).toBeGreaterThan(0);
      expect(wire.tags.length).toBeGreaterThan(0);
    });

    it('renders every value and count in the format() text too', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({}),
        ctx,
      );
      const rendered = text(listCatalogVocabulary.format!(result));

      expect(result.categories.length + result.tags.length).toBeGreaterThan(0);
      for (const term of [...result.categories, ...result.tags]) {
        expect(rendered).toContain(term.value);
        expect(rendered).toContain(String(term.datasetCount));
      }
      expect(rendered).toContain('data.cdc.gov');
    });

    it('renders an empty vocabulary as a stated absence rather than a bare table', async () => {
      mockListCategories.mockResolvedValue([]);
      mockListTags.mockResolvedValue([]);
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({}),
        ctx,
      );

      expect(text(listCatalogVocabulary.format!(result))).toContain('None matched.');
    });
  });

  describe('tag window', () => {
    it('returns every matching tag and discloses no truncation when they all fit', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({}),
        ctx,
      );

      expect(result.tags).toHaveLength(TAGS.length);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toBeUndefined();
      expect(enrichment.tagCount).toBe(TAGS.length);
      expect(enrichment.categoryCount).toBe(CATEGORIES.length);
      expect(enrichment.vocabularySize).toEqual({
        categories: CATEGORIES.length,
        tags: TAGS.length,
      });
    });

    it('discloses the cap, the remainder, and a count ceiling when the page is cut', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ tag_limit: 2 }),
        ctx,
      );

      expect(result.tags.map((t) => t.value)).toEqual(['nndss', 'covid-19']);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(2);
      expect(enrichment.cap).toBe(2);
      expect(enrichment.nextOffset).toBe(2);
      // Ranked by count, so nothing left out is carried by more than the last one shown.
      expect(enrichment.truncationCeiling).toBe(176);
      expect(enrichment.notice).toContain('Showing tags 1–2 of 6');
      expect(enrichment.notice).toContain('tag_offset=2');
      expect(enrichment.notice).toContain('raise tag_limit (max 500)');
    });

    it('stops offering a bigger page once tag_limit is already at the ceiling', async () => {
      /** Advice the caller cannot take reads as a dead end at the moment they need the next move. */
      mockListTags.mockResolvedValue(
        Array.from({ length: 600 }, (_, i) => ({ value: `tag-${i}`, datasetCount: 600 - i })),
      );
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ tag_limit: 500 }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('Showing tags 1–500 of 600');
      expect(notice).toContain('tag_offset=500');
      expect(notice).not.toContain('raise tag_limit');
    });

    it('leaves the categories whole however tight the tag window is', async () => {
      /**
       * 55 categories cost roughly 3 KB while 1,583 tags cost roughly 66 KB, so the page
       * bounds one vocabulary and not the other. A tag_limit that also trimmed categories
       * would hide the smaller vocabulary behind the larger one's cost.
       */
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ tag_limit: 1 }),
        ctx,
      );

      expect(result.categories).toHaveLength(CATEGORIES.length);
      expect(result.tags).toHaveLength(1);
    });

    it('continues from a tag_offset without gaps or repeats', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ tag_limit: 2, tag_offset: 2 }),
        ctx,
      );

      expect(result.tags.map((t) => t.value)).toEqual(['vaccination', 'covid-19 vaccination']);
      expect(getEnrichment(ctx).nextOffset).toBe(4);
    });

    it('returns an empty tag list rather than an error when tag_offset runs past the end', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ tag_offset: 500 }),
        ctx,
      );

      expect(result.tags).toEqual([]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('tag_offset 500 is past the end of the 6 matching tags');
      expect(enrichment.nextOffset).toBeUndefined();
      // No page was shown, so there is no smallest-shown value to bound the omitted ones by.
      expect(enrichment.truncationCeiling).toBeUndefined();
    });
  });

  describe('filter', () => {
    it('narrows both vocabularies and reports the matched counts against the full size', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ filter: 'vaccin' }),
        ctx,
      );

      expect(result.categories.map((c) => c.value)).toEqual(['Vaccinations', 'Child Vaccinations']);
      expect(result.tags.map((t) => t.value)).toEqual([
        'vaccination',
        'covid-19 vaccination',
        'flu vaccination',
      ]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.categoryCount).toBe(2);
      expect(enrichment.tagCount).toBe(3);
      // The full sizes stay visible, so the agent can see how much the filter cut.
      expect(enrichment.vocabularySize).toEqual({ categories: 5, tags: 6 });
    });

    it('filters the whole vocabulary rather than the page', async () => {
      /**
       * `zoster` is the least-used tag in the fixture, so it falls outside any small page.
       * Filtering after the cut would search only the tags that happened to rank highest and
       * report that the value does not exist.
       */
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ filter: 'zoster', tag_limit: 1 }),
        ctx,
      );

      expect(result.tags.map((t) => t.value)).toEqual(['zoster']);
      expect(getEnrichment(ctx).tagCount).toBe(1);
    });

    it('says so when the filter matches nothing, and does not read it as an outage', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ filter: 'zzznothinghere' }),
        ctx,
      );

      expect(result.categories).toEqual([]);
      expect(result.tags).toEqual([]);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('No category or tag matches "zzznothinghere"');
      expect(enrichment.categoryCount).toBe(0);
      expect(enrichment.vocabularySize).toEqual({ categories: 5, tags: 6 });
    });

    describe('too short to discriminate', () => {
      /**
       * A one- or two-character filter is a substring of most of the 1,583 live tags, so a
       * containment test on it carries no signal and the matcher answers nothing. Reporting
       * that as "no match" sends the caller after a spelling problem that does not exist —
       * the filter is ignored instead and the unfiltered vocabulary comes back.
       */
      it.each(['v', 'va'])('returns the unfiltered vocabulary for %j', async (filter) => {
        const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
        const result = await listCatalogVocabulary.handler(
          listCatalogVocabulary.input.parse({ filter }),
          ctx,
        );

        expect(result.categories).toEqual(CATEGORIES);
        expect(result.tags).toEqual(TAGS);
        const enrichment = getEnrichment(ctx);
        expect(enrichment.categoryCount).toBe(CATEGORIES.length);
        expect(enrichment.tagCount).toBe(TAGS.length);
      });

      it('narrows normally at the threshold', async () => {
        /** One character longer than the ignored filters above, and matching resumes. */
        const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
        const result = await listCatalogVocabulary.handler(
          listCatalogVocabulary.input.parse({ filter: 'vac' }),
          ctx,
        );

        expect(result.categories.map((c) => c.value)).toEqual([
          'Vaccinations',
          'Child Vaccinations',
        ]);
        expect(result.tags.map((t) => t.value)).toEqual([
          'vaccination',
          'covid-19 vaccination',
          'flu vaccination',
        ]);
        expect(getEnrichment(ctx).notice).toBeUndefined();
      });

      it('says the filter was ignored and names the minimum, without blaming the spelling', async () => {
        const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
        await listCatalogVocabulary.handler(
          listCatalogVocabulary.input.parse({ filter: 'va' }),
          ctx,
        );

        const notice = getEnrichment(ctx).notice as string;
        expect(notice).toContain('"va"');
        expect(notice).toContain('ignored');
        expect(notice).toContain('at least 3');
        expect(notice).not.toContain('No category or tag matches');
        expect(notice).not.toContain('misspelling');
      });

      it('carries the values and the notice on content[] as well as structuredContent', async () => {
        /**
         * Clients read one surface or the other, so the ignored filter has to be visible on
         * both: a client reading only `content[]` would otherwise see a vocabulary with no
         * explanation of why the filter it sent did nothing.
         */
        const result = await runToolContract(listCatalogVocabulary, { filter: 'va' });

        expect(result.structuredContent).toMatchObject({ categories: CATEGORIES, tags: TAGS });
        const rendered = result.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('\n');
        expect(rendered).toContain('ignored');
        expect(rendered).toContain('at least 3');
        for (const term of [...CATEGORIES, ...TAGS]) expect(rendered).toContain(term.value);
      });

      it('keeps the paging guidance alongside the ignored-filter notice', async () => {
        /** Both facts apply to one response; one notice writer must not destroy the other. */
        const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
        await listCatalogVocabulary.handler(
          listCatalogVocabulary.input.parse({ filter: 'va', tag_limit: 2 }),
          ctx,
        );

        const enrichment = getEnrichment(ctx);
        expect(enrichment.notice).toContain('ignored');
        expect(enrichment.notice).toContain('Showing tags 1–2 of 6');
        expect(enrichment.tagCount).toBe(TAGS.length);
        expect(enrichment.nextOffset).toBe(2);
      });
    });
  });

  describe('input validation', () => {
    it('defaults to data.cdc.gov, 50 tags, offset 0', () => {
      const input = listCatalogVocabulary.input.parse({});
      expect(input).toMatchObject({ domain: 'data.cdc.gov', tag_limit: 50, tag_offset: 0 });
    });

    it('passes the requested domain through to both vocabulary reads', async () => {
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });
      const result = await listCatalogVocabulary.handler(
        listCatalogVocabulary.input.parse({ domain: 'chronicdata.cdc.gov' }),
        ctx,
      );

      expect(mockListCategories).toHaveBeenCalledWith('chronicdata.cdc.gov', ctx.signal);
      expect(mockListTags).toHaveBeenCalledWith('chronicdata.cdc.gov', ctx.signal);
      expect(result.domain).toBe('chronicdata.cdc.gov');
    });

    it.each([
      { tag_limit: 0 },
      { tag_limit: 501 },
      { tag_limit: 2.5 },
      { tag_limit: '50' },
      { tag_offset: -1 },
      { tag_offset: 10_001 },
      { tag_offset: 1.5 },
      { domain: 'evil.com' },
      { filter: 42 },
    ])('rejects %j', (patch) => {
      expect(() => listCatalogVocabulary.input.parse(patch)).toThrow();
    });

    it('accepts the ends of the tag window ranges', () => {
      expect(listCatalogVocabulary.input.parse({ tag_limit: 1 }).tag_limit).toBe(1);
      expect(listCatalogVocabulary.input.parse({ tag_limit: 500 }).tag_limit).toBe(500);
      expect(listCatalogVocabulary.input.parse({ tag_offset: 10_000 }).tag_offset).toBe(10_000);
    });
  });

  describe('error contract', () => {
    it.each([
      {
        reason: 'dataset_not_found',
        code: JsonRpcErrorCode.NotFound,
        throw: () => notFound('Catalog endpoint not found (404).', { reason: 'dataset_not_found' }),
      },
      {
        reason: 'access_denied',
        code: JsonRpcErrorCode.Forbidden,
        throw: () => forbidden('Socrata denied access (403).', { reason: 'access_denied' }),
      },
      {
        reason: 'rate_limited',
        code: JsonRpcErrorCode.RateLimited,
        throw: () => rateLimited('Rate limited (429).', { reason: 'rate_limited' }),
      },
      {
        reason: 'upstream_error',
        code: JsonRpcErrorCode.ServiceUnavailable,
        throw: () => serviceUnavailable('Socrata 503.', { reason: 'upstream_error' }),
      },
      {
        reason: 'invalid_query',
        code: JsonRpcErrorCode.ValidationError,
        throw: () => validationError('Socrata rejected the request.', { reason: 'invalid_query' }),
      },
    ])('re-dispatches $reason with the contract recovery on the wire', async (scenario) => {
      mockListCategories.mockRejectedValue(scenario.throw());
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });

      const err = (await Promise.resolve(
        listCatalogVocabulary.handler(listCatalogVocabulary.input.parse({}), ctx),
      ).catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(scenario.code);
      expect(err.data).toMatchObject({ reason: scenario.reason });
      /**
       * `recovery` is required on every contract entry but only reaches the client when the
       * throw site forwards it. Without this the error ships a reason and no next move, and
       * both client surfaces lose the hint together.
       */
      const hint = (err.data as { recovery?: { hint?: string } }).recovery?.hint;
      const declared = listCatalogVocabulary.errors?.find((e) => e.reason === scenario.reason);
      expect(hint).toBe(declared?.recovery);
    });

    it('rethrows an unreasoned failure unchanged rather than inventing a reason', async () => {
      /**
       * A status outside the service's reason ladder carries no `data.reason`; rebuilding it
       * as a declared reason would tell the caller something the upstream never said.
       */
      mockListTags.mockRejectedValue(new Error('socket hang up'));
      const ctx = createMockContext({ errors: listCatalogVocabulary.errors });

      await expect(
        listCatalogVocabulary.handler(listCatalogVocabulary.input.parse({}), ctx),
      ).rejects.toThrow(/socket hang up/);
    });

    it('declares no reason the Socrata service cannot raise', () => {
      /**
       * `ctx.fail` with an undeclared reason returns an InternalError carrying the whole
       * declared-reason list to the client, so the contract has to line up with the shared
       * `fetchJson` ladder — and must not claim the handler-raised reasons it never throws.
       */
      const declared = new Set(listCatalogVocabulary.errors?.map((e) => e.reason));
      expect([...declared].sort()).toEqual([
        'access_denied',
        'dataset_not_found',
        'invalid_query',
        'rate_limited',
        'upstream_error',
      ]);
    });
  });

  describe('definition surface', () => {
    it('names the tool cdc_list_catalog_vocabulary and marks it read-only', () => {
      expect(listCatalogVocabulary.name).toBe('cdc_list_catalog_vocabulary');
      expect(listCatalogVocabulary.annotations?.readOnlyHint).toBe(true);
    });

    it('tells the caller the categories arrive whole and the tags are paged', () => {
      /**
       * The asymmetry is the tool's one surprising behavior — a reader who assumes tag_limit
       * bounds both will page looking for categories that were never withheld.
       */
      expect(listCatalogVocabulary.input.shape.tag_limit.description).toContain(
        'Categories are never paged',
      );
      expect(listCatalogVocabulary.description).toContain('categories come back whole');
    });

    it('renders the structured vocabularySize enrichment as markdown, not a JSON blob', () => {
      const rendered = listCatalogVocabulary.enrichmentTrailer?.vocabularySize?.render?.({
        categories: 55,
        tags: 1583,
      });

      expect(rendered).toBe('**Vocabulary:** 55 categories · 1583 tags');
    });
  });
});
