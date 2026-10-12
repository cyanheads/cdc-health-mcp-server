/**
 * @fileoverview Tests for cdc_discover_datasets tool.
 * @module tests/mcp-server/tools/definitions/discover-datasets
 */

import { type ErrorContract, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import type { CatalogDataset, DiscoverResult, VocabularyTerm } from '@/services/socrata/types.js';
import { contractError } from '../../../helpers/contract-error.js';
import {
  contentText,
  readBack,
  renderMarkdown,
  strayElements,
} from '../../../helpers/markdown-render.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();
const mockListCategories = vi.fn<() => Promise<VocabularyTerm[]>>();
const mockListTags = vi.fn<() => Promise<VocabularyTerm[]>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({
    discover: mockDiscover,
    listCategories: mockListCategories,
    listTags: mockListTags,
  }),
}));

const sampleDataset: CatalogDataset = {
  id: 'bi63-dtpu',
  name: 'Diabetes Mortality',
  description: 'State-level diabetes death rates',
  category: 'NCHS',
  tags: ['diabetes', 'mortality'],
  columnNames: ['state', 'year', 'deaths'],
  columnTypes: ['text', 'number', 'number'],
  updatedAt: '2024-01-15T00:00:00.000Z',
  pageViews: 5000,
};

const sampleServiceResult: DiscoverResult = {
  datasets: [sampleDataset],
  totalCount: 1,
};

/** The live `data.cdc.gov` category vocabulary, trimmed to the values a near miss reaches. */
const CATEGORY_VOCABULARY: VocabularyTerm[] = [
  { value: 'NNDSS', datasetCount: 295 },
  { value: 'National Center for Health Statistics', datasetCount: 287 },
  { value: 'Vaccinations', datasetCount: 89 },
  { value: 'Motor Vehicle', datasetCount: 45 },
  { value: 'Child Vaccinations', datasetCount: 15 },
  { value: 'Flu Vaccinations', datasetCount: 13 },
];

const TAG_VOCABULARY: VocabularyTerm[] = [
  { value: 'nndss', datasetCount: 294 },
  { value: 'covid-19', datasetCount: 176 },
  { value: 'vaccination', datasetCount: 41 },
  { value: 'covid-19 vaccination', datasetCount: 35 },
];

describe('cdc_discover_datasets', () => {
  beforeEach(() => {
    // Default to a vocabulary that matches nothing, so only the tests that opt in pay the
    // near-miss path; the handler treats a rejected lookup and an empty one the same way.
    mockListCategories.mockResolvedValue([]);
    mockListTags.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns datasets for a valid query', async () => {
    mockDiscover.mockResolvedValue(sampleServiceResult);
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({ query: 'diabetes' });
    const result = await discoverDatasets.handler(input, ctx);

    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0]?.id).toBe('bi63-dtpu');
  });

  it('surfaces assetType alongside columnCount so a caller can skip non-tabular entries', async () => {
    /**
     * A file and an href arrive with a four-by-four ID and a name just like a dataset.
     * Without the type label and a zero column count, picking one costs two more calls
     * before anything says why nothing came back.
     */
    mockDiscover.mockResolvedValue({
      datasets: [
        { id: 'bi63-dtpu', name: 'Leading Causes', assetType: 'dataset', columnNames: ['state'] },
        { id: '235m-gsry', name: 'Pulmonary evaluation', assetType: 'file', columnNames: [] },
        { id: 's2qv-b27b', name: 'DHDS', assetType: 'filter', columnNames: ['year', 'state'] },
      ],
      totalCount: 3,
    });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

    /**
     * Read through the output schema, not off the raw handler return: the framework parses
     * the result against `output` before it reaches structuredContent, so an undeclared
     * field is stripped on the way out no matter what the handler built.
     */
    const wire = discoverDatasets.output.parse(result);
    expect(wire.datasets.map((d) => [d.id, d.assetType, d.columnCount])).toEqual([
      ['bi63-dtpu', 'dataset', 1],
      ['235m-gsry', 'file', 0],
      // A `filter` asset carries real columns and queries normally — type alone would hide it.
      ['s2qv-b27b', 'filter', 2],
    ]);
  });

  it('tells the caller in the field descriptions which of the two fields decides queryability', () => {
    /**
     * The two fields are read together and mean different things: `assetType` is the
     * catalog's label and `columnCount` is the test. A model that reads `assetType` as the
     * test drops every queryable `filter` entry, so the descriptions have to say which is
     * which — nothing else on the wire does.
     */
    const fields = discoverDatasets.output.shape.datasets.element.shape;

    expect(fields.assetType.description).toContain('Descriptive only');
    expect(fields.assetType.description).toContain('Read columnCount, not this field');
    expect(fields.columnCount.description).toContain('A count of 0 means the entry is not tabular');
    expect(fields.columnCount.description).toContain('cdc_get_dataset_schema');
  });

  it('points the description field at the call that returns the whole text', () => {
    /** cdc_get_dataset_schema caps descriptions by default, so naming the tool alone is not enough. */
    const fields = discoverDatasets.output.shape.datasets.element.shape;
    expect(fields.description.description).toContain(
      'Fetch the full text via cdc_get_dataset_schema with full_description: true',
    );
  });

  it('trims discovery output: columnCount + capped columnSample, no full column arrays', async () => {
    const wideColumns = Array.from({ length: 30 }, (_, i) => `col_${i}`);
    mockDiscover.mockResolvedValue({
      datasets: [
        {
          ...sampleDataset,
          columnNames: wideColumns,
          columnTypes: wideColumns.map(() => 'text'),
        },
      ],
      totalCount: 1,
    });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const result = await discoverDatasets.handler(
      discoverDatasets.input.parse({ query: 'wide' }),
      ctx,
    );

    const ds = result.datasets[0] as Record<string, unknown>;
    expect(ds.columnCount).toBe(30);
    expect(ds.columnSample).toHaveLength(8);
    expect(ds.columnSample).toEqual(wideColumns.slice(0, 8));
    // The full parallel arrays must not survive into output.
    expect(ds).not.toHaveProperty('columnNames');
    expect(ds).not.toHaveProperty('columnTypes');
    expect(result).toEqual(expect.schemaMatching(discoverDatasets.output));
  });

  it('truncates long descriptions to ~300 chars with an ellipsis', async () => {
    const longDescription = 'D'.repeat(500);
    mockDiscover.mockResolvedValue({
      datasets: [{ id: 'ab12-cd34', name: 'Verbose', description: longDescription }],
      totalCount: 1,
    });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

    const description = (result.datasets[0] as { description: string }).description;
    expect(description.endsWith('…')).toBe(true);
    expect(description.length).toBe(301); // 300 chars + ellipsis
  });

  it('spends the truncation budget on visible text, not markup', async () => {
    /**
     * Catalog descriptions arrive as raw HTML. Truncating before the markup came off spent
     * the whole 300-character budget on tags and inline CSS, so the ellipsis landed before
     * the first word about the dataset.
     */
    const markup =
      '</p><p style="margin:0in;vertical-align:baseline;"><strong><em>' +
      `<span style='font-size:15px;font-family:"Calibri",sans-serif;color:black;'>` +
      'After October 13, 2022, this dataset will no longer be updated.</span></em></strong>' +
      '<p>This dataset contains historical trends in vaccinations and cases by age group.</p>';
    mockDiscover.mockResolvedValue({
      datasets: [{ id: 'gxj9-t96f', name: 'Vaccination Trends', description: markup }],
      totalCount: 1,
    });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

    const description = (result.datasets[0] as { description: string }).description;
    expect(description).not.toContain('<');
    expect(description).not.toContain('style=');
    expect(description).toContain('After October 13, 2022');
    expect(description).toContain('historical trends in vaccinations and cases by age group');
  });

  it('decodes an escaped entity exactly once so pre-escaped markup stays text', async () => {
    /**
     * A chained decode resolves `&amp;` first and turns `&amp;lt;` into `<`, manufacturing
     * markup the publisher escaped so it would not be markup.
     */
    mockDiscover.mockResolvedValue({
      datasets: [
        {
          id: 'ab12-cd34',
          name: 'Escaped',
          description: 'Counts of &amp;lt;1 year olds &amp; &#39;infants&#39;.',
        },
      ],
      totalCount: 1,
    });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

    const description = (result.datasets[0] as { description: string }).description;
    expect(description).toBe("Counts of &lt;1 year olds & 'infants'.");
  });

  it('threads the domain through to the service', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({
      query: 'places',
      domain: 'chronicdata.cdc.gov',
    });
    await discoverDatasets.handler(input, ctx);

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'chronicdata.cdc.gov', query: 'places' }),
      ctx.signal,
    );
  });

  it('defaults domain to data.cdc.gov', () => {
    expect(discoverDatasets.input.parse({}).domain).toBe('data.cdc.gov');
  });

  it('enriches with totalCount and appliedFilters', async () => {
    mockDiscover.mockResolvedValue(sampleServiceResult);
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({ query: 'diabetes', category: 'NCHS' });
    await discoverDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.appliedFilters).toEqual({ query: 'diabetes', category: 'NCHS' });
    expect(enrichment.notice).toBeUndefined();
  });

  it('emits a notice when no datasets matched', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({ query: 'nonexistent' });
    await discoverDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No datasets found');
    expect(enrichment.notice).toContain('nonexistent');
    expect(enrichment.totalCount).toBe(0);
  });

  describe('blank filters', () => {
    /** Call the tool and return the service options it sent alongside the whole result. */
    const call = async (input: Record<string, unknown>) => {
      mockDiscover.mockClear();
      const result = await runToolContract(discoverDatasets, input);
      const [options] = mockDiscover.mock.calls[0] as unknown as [Record<string, unknown>];
      return { result, options };
    };

    it.each([
      ['whitespace query and category, on a page', sampleServiceResult],
      ['whitespace query and category, on an empty page', { datasets: [], totalCount: 0 }],
    ])('reads %s as omitted', async (_label, page) => {
      mockDiscover.mockResolvedValue(page);
      const blank = await call({ query: '  ', category: ' \t ' });
      const omitted = await call({});

      expect(blank.options.query).toBeUndefined();
      expect(blank.options.category).toBeUndefined();
      expect(blank.result).toEqual(omitted.result);
      expect(mockListCategories).not.toHaveBeenCalled();
    });

    it('drops blank tag entries before the request and the echo', async () => {
      mockDiscover.mockResolvedValue(sampleServiceResult);
      const blank = await call({ tags: ['', 'covid19', '  '] });
      const clean = await call({ tags: ['covid19'] });

      expect(blank.options.tags).toEqual(['covid19']);
      expect(blank.result).toEqual(clean.result);
      expect(contentText(blank.result)).toMatch(/^- \*\*Tags \(any of\):\*\* covid19$/m);
    });

    it('reads a tag list of blanks alone as no tag filter, near-miss lookup included', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const blank = await call({ tags: ['', ' '] });
      const omitted = await call({});

      expect(blank.options.tags).toBeUndefined();
      expect(blank.result).toEqual(omitted.result);
      expect(mockListTags).not.toHaveBeenCalled();
    });

    it('keeps a non-blank value exactly as sent, surrounding whitespace included', async () => {
      mockDiscover.mockResolvedValue(sampleServiceResult);
      const { result, options } = await call({ query: ' flu ', tags: [' covid19'] });

      expect(options).toMatchObject({ query: ' flu ', tags: [' covid19'] });
      expect(result.structuredContent).toMatchObject({
        appliedFilters: { query: ' flu ', tags: [' covid19'] },
      });
    });
  });

  describe('tag semantics', () => {
    /**
     * The Discovery API sends one `tags` parameter per value and unions them: on
     * data.cdc.gov `covid19` alone matches 19 entries, `vaccination` alone 41, and the two
     * together 59. Every surface that names tags has to say so, or adding one reads as
     * narrowing and does the opposite.
     */
    it('renders applied tag filters as a union, not a conjunction', () => {
      const rendered = discoverDatasets.enrichmentTrailer?.appliedFilters?.render?.({
        query: 'flu',
        tags: ['covid19', 'vaccination'],
      });

      expect(rendered).toContain('**Tags (any of):** covid19, vaccination');
    });

    it('states in the tags description that each added tag widens the result set', () => {
      const description = discoverDatasets.input.shape.tags.description ?? '';

      expect(description).toContain('any one of them');
      expect(description).toContain('widen');
      expect(description).toContain('unrecognized tag matches nothing');
    });

    it('carries the union semantics on the echo surfaces too, not just the input', () => {
      /**
       * The input description is read once, before the call; the enrichment travels back
       * with every result. Both have to say the same thing, or the echo quietly restates
       * tags as a conjunction after the input said otherwise.
       */
      const trailer = discoverDatasets.enrichment?.appliedFilters.description ?? '';
      expect(trailer).toContain('multiple tags union');

      const tagsField = discoverDatasets.enrichment?.appliedFilters.shape.tags.description ?? '';
      expect(tagsField).toContain('any one of them');
    });

    it('points a tag-filtered no-match at the catalog vocabulary', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ tags: ['covid19', 'zzzznotag'] }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      // The criteria echo has to read as a union too, or it contradicts the guidance.
      expect(notice).toContain('any of tags [covid19, zzzznotag]');
      expect(notice).toContain('a tag no dataset carries contributes nothing');
      expect(notice).toContain('cdc_list_catalog_vocabulary');
    });

    it('leaves the vocabulary hint out of a no-match that used no tags', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(discoverDatasets.input.parse({ query: 'nonexistent' }), ctx);

      expect(getEnrichment(ctx).notice).not.toContain(
        'a tag no dataset carries contributes nothing',
      );
      expect(getEnrichment(ctx).notice).not.toContain('cdc_list_catalog_vocabulary');
    });
  });

  describe('near-miss resolution on an empty page', () => {
    /**
     * `category` and `tags` are matched against the catalog's own controlled vocabulary, so a
     * near miss returns nothing and reads identically to a real value with no datasets. The
     * notice resolves the filter against the vocabulary and names what is actually there.
     */
    it('names the closest category with its dataset count instead of advising a broader search', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListCategories.mockResolvedValue(CATEGORY_VOCABULARY);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Vaccination' }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No datasets found for category "Vaccination"');
      expect(notice).toContain('"Vaccinations" (89 datasets)');
      // The broadening advice is what the near miss replaces — the search itself was fine.
      expect(notice).not.toContain('Try broader search terms');
      expect(mockListCategories).toHaveBeenCalledWith('data.cdc.gov', ctx.signal);
    });

    it('ranks several near misses by dataset count and caps the list at three', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListCategories.mockResolvedValue(CATEGORY_VOCABULARY);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Vaccination' }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      const named = [...notice.matchAll(/"([^"]+)" \((\d+) datasets\)/g)].map((m) => m[1]);
      expect(named).toEqual(['Vaccinations', 'Child Vaccinations', 'Flu Vaccinations']);
      // Unrelated vocabulary must not leak in, or "closest" means nothing.
      expect(notice).not.toContain('Motor Vehicle');
    });

    it('resolves every supplied tag and merges the candidates into one ranked list', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListTags.mockResolvedValue(TAG_VOCABULARY);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ tags: ['vaccinations', 'nndss weekly'] }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      const named = [...notice.matchAll(/"([^"]+)" \((\d+) datasets\)/g)].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      // "nndss weekly" resolves by the reverse direction (the value sits inside the filter),
      // "vaccinations" by the forward one, and the merged list is count-ranked.
      expect(named).toEqual(['nndss', 'vaccination', 'covid-19 vaccination']);
      expect(mockListTags).toHaveBeenCalledWith('data.cdc.gov', ctx.signal);
    });

    it('resolves only the dimension that was filtered', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListCategories.mockResolvedValue(CATEGORY_VOCABULARY);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Vaccination' }),
        ctx,
      );

      expect(mockListCategories).toHaveBeenCalledTimes(1);
      expect(mockListTags).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'a page with results', input: { category: 'Vaccinations' }, datasets: 1 },
      { label: 'an empty page with no vocabulary filter', input: { query: 'zzz' }, datasets: 0 },
    ])('reads no vocabulary for $label', async ({ input, datasets }) => {
      mockDiscover.mockResolvedValue({
        datasets: Array.from({ length: datasets }, () => sampleDataset),
        totalCount: datasets,
      });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(discoverDatasets.input.parse(input), ctx);

      expect(mockListCategories).not.toHaveBeenCalled();
      expect(mockListTags).not.toHaveBeenCalled();
    });

    it('reads no vocabulary when the offset ran past the end of a matching search', async () => {
      /**
       * The search matched — the page is empty only because the walk went past it. Resolving
       * a near miss there would spend a request to answer a question nobody asked.
       */
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 89 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Vaccinations', offset: 100 }),
        ctx,
      );

      expect(mockListCategories).not.toHaveBeenCalled();
      expect(getEnrichment(ctx).notice).toContain('Offset 100 is past the end');
    });

    it('falls back to the broadening advice when nothing in the vocabulary is close', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListCategories.mockResolvedValue(CATEGORY_VOCABULARY);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Zzznotacategory' }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('Try broader search terms');
      expect(notice).toContain('cdc_list_catalog_vocabulary');
      expect(notice).not.toMatch(/\(\d+ datasets\)/);
    });

    it('keeps the discovery answer when the vocabulary lookup fails', async () => {
      /**
       * The near miss annotates a response that is already correct. A catalog outage on the
       * vocabulary endpoint must not turn a valid empty result into a failed call.
       */
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListCategories.mockRejectedValue(new Error('catalog unreachable'));
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const result = await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Vaccination' }),
        ctx,
      );

      expect(result.datasets).toEqual([]);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No datasets found for category "Vaccination"');
      expect(notice).toContain('Try broader search terms');
    });

    it('carries the near miss as enrichment rather than hand-authored format text', async () => {
      /**
       * The notice has to be enrichment, not a line in `format()`: the framework merges
       * enrichment into `structuredContent` and mirrors it into the `content[]` trailer, so
       * declaring it once reaches both client surfaces. Authored into `format()` instead, it
       * would be invisible to every structuredContent-only client.
       */
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      mockListCategories.mockResolvedValue(CATEGORY_VOCABULARY);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const result = await discoverDatasets.handler(
        discoverDatasets.input.parse({ category: 'Vaccination' }),
        ctx,
      );

      expect(getEnrichment(ctx).notice).toContain('"Vaccinations" (89 datasets)');
      expect(discoverDatasets.enrichment?.notice).toBeDefined();
      const text = (discoverDatasets.format!(result)[0] as { type: 'text'; text: string }).text;
      expect(text).not.toContain('Vaccinations');
    });
  });

  it('names the category filter and offers broadening advice when nothing matched it', async () => {
    /**
     * Characterization of the category arm of the empty-result notice: the criteria echo
     * names the value the caller sent, and the guidance tells them how to widen. Pinned
     * because both halves have to survive whatever else the notice grows.
     */
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    await discoverDatasets.handler(
      discoverDatasets.input.parse({ category: 'Zzznotacategory' }),
      ctx,
    );

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('No datasets found for category "Zzznotacategory"');
    expect(notice).toContain('remove category/tag filters');
    expect(getEnrichment(ctx).appliedFilters).toEqual({ category: 'Zzznotacategory' });
  });

  it('emits a notice with no criteria when no filters applied', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({});
    await discoverDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No datasets found');
    expect(enrichment.appliedFilters).toEqual({});
  });

  it('passes all options to the service', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({
      query: 'covid',
      category: 'NNDSS',
      tags: ['surveillance'],
      limit: 25,
      offset: 10,
    });
    await discoverDatasets.handler(input, ctx);

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'covid',
        category: 'NNDSS',
        tags: ['surveillance'],
        limit: 25,
        offset: 10,
      }),
      ctx.signal,
    );
  });

  it('applies defaults for limit and offset', () => {
    const input = discoverDatasets.input.parse({});
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(0);
  });

  it('defaults order to dataset_id and threads it to the service', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({ query: 'diabetes mortality' });
    expect(input.order).toBe('dataset_id');
    await discoverDatasets.handler(input, ctx);

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'dataset_id' }),
      ctx.signal,
    );
  });

  it('forwards an explicit order override to the service', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: discoverDatasets.errors });
    const input = discoverDatasets.input.parse({ query: 'diabetes', order: 'relevance' });
    await discoverDatasets.handler(input, ctx);

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'relevance' }),
      ctx.signal,
    );
  });

  it('rejects an unsupported order value', () => {
    expect(() => discoverDatasets.input.parse({ order: 'last_modified' })).toThrow();
  });

  describe('limit past the 100-entry cap', () => {
    /** A full page of 100 entries out of the live catalog's 1,084. */
    const fullPage = (n: number): DiscoverResult => ({
      datasets: Array.from({ length: n }, (_, i) => ({
        ...sampleDataset,
        id: `ab${String(i).padStart(2, '0')}-cd34`,
      })),
      totalCount: 1084,
    });
    const notice = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;
    const expectCappedRequest = () =>
      expect(mockDiscover).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
        expect.anything(),
      );

    it.each([101, 10_000])(
      'clamps limit %i to 100 and names the cap and the offset to continue from',
      async (limit) => {
        mockDiscover.mockResolvedValue(fullPage(100));
        const result = await runToolContract(discoverDatasets, { limit, offset: 200 });

        expectCappedRequest();
        expect((result.structuredContent as { datasets: unknown[] }).datasets).toHaveLength(100);
        expect(notice(result)).toBe(
          `More datasets match beyond this page — limit=${limit} is above the 100 datasets one call returns, so the page stopped at 100. Call again with offset=300 to continue.`,
        );
        const html = renderMarkdown(contentText(result));
        const quote = html.match(/<blockquote>([\s\S]*?)<\/blockquote>/)?.[1] ?? '';
        expect(readBack(quote)).toContain(`limit=${limit} is above the 100 datasets`);
      },
    );

    it('clamps a limit the framework repaired from a string ("6000")', async () => {
      mockDiscover.mockResolvedValue(fullPage(100));
      const args = { limit: '6000' } as unknown as Record<string, unknown>;
      const result = await runToolContract(discoverDatasets, args);

      expect(result.isError).toBeFalsy();
      expectCappedRequest();
      expect(notice(result)).toContain('limit=6000 is above the 100 datasets one call returns');
    });

    it('rejects limit above 10,000, the catalog window no page can cross', async () => {
      const result = await runToolContract(discoverDatasets, { limit: 10_001 });
      expect(result.isError).toBe(true);
      expect(
        (result.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
      ).toBe('invalid_arguments');
      expect(mockDiscover).not.toHaveBeenCalled();
    });

    it('says nothing of the cap when the clamped page holds the rest of the matches', async () => {
      mockDiscover.mockResolvedValue({ ...fullPage(84), totalCount: 1084 });
      const result = await runToolContract(discoverDatasets, { limit: 500, offset: 1000 });

      expectCappedRequest();
      expect(notice(result)).toBeUndefined();
    });

    it('adds no clamp notice for a limit at or below the cap', async () => {
      mockDiscover.mockResolvedValue(fullPage(100));
      const result = await runToolContract(discoverDatasets, { limit: 100 });

      expect(mockDiscover).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
        expect.anything(),
      );
      expect(notice(result)).toBeUndefined();
    });

    it('delivers an empty-page notice and the clamp notice as one notice', async () => {
      /**
       * The catalog reports more matches than the window holds and returns none of them: both
       * facts apply, and a second notice write would silently replace the first.
       */
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 1084 });
      const result = await runToolContract(discoverDatasets, { query: 'flu', limit: 250 });

      expect(notice(result)).toBe(
        'No datasets found for query "flu". Try broader search terms, different keywords, or remove category/tag filters. Browse all datasets by calling with no parameters. More datasets match beyond this page — limit=250 is above the 100 datasets one call returns, so the page stopped at 100. Call again with offset=100 to continue.',
      );
    });

    it('states the cap and the window in the limit description', () => {
      const description = discoverDatasets.input.shape.limit.description ?? '';
      expect(description).toBe(
        'Results to return (default 10). One call returns at most 100: a larger limit, up to 10,000, is capped at 100, and the response says so and gives the offset to continue from while more datasets match. offset plus limit must not exceed 10000 once limit is capped.',
      );
    });
  });

  describe('format', () => {
    it('renders dataset details in markdown', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          {
            id: 'bi63-dtpu',
            name: 'Diabetes Mortality',
            description: 'State-level diabetes death rates',
            category: 'NCHS',
            tags: ['diabetes', 'mortality'],
            columnCount: 3,
            columnSample: ['state', 'year', 'deaths'],
            updatedAt: '2024-01-15T00:00:00.000Z',
            pageViews: 5000,
          },
        ],
      });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('text');
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('bi63-dtpu');
      expect(text).toContain('Diabetes Mortality');
      expect(text).toContain('NCHS');
      // Full column count with the sample preview inline (not an exhaustive list).
      expect(text).toContain('**Columns:** 3 (`state`, `year`, `deaths`)');
    });

    it('renders empty-state message when no datasets', () => {
      const blocks = discoverDatasets.format!({ datasets: [] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No datasets matched');
    });

    it('renders the column count with a capped sample for wide datasets', () => {
      const sample = Array.from({ length: 8 }, (_, i) => `col_${i}`);
      const blocks = discoverDatasets.format!({
        datasets: [{ id: 'ab12-cd34', name: 'Wide', columnCount: 110, columnSample: sample }],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Columns:** 110 (e.g. `col_0`');
      expect(text).toContain('…)');
      // The full inventory is gone — no 100+ column names dumped into the text.
      expect(text).not.toContain('col_14');
      expect(text).not.toContain('col_9');
    });
  });

  describe('content[] Markdown rendering', () => {
    const HOSTILE_ENTRY: CatalogDataset = {
      id: 'ab12-cd34',
      name: '**Bold** <i>x</i> Cases #',
      description: '2000. # [x](http://e.com) *y* _z_',
      category: '*Cat* <b>',
      tags: ['<b>t</b>', 'a_b', '_x_'],
      assetType: 'dataset',
      columnNames: ['_c_', 'data_value_type'],
      updatedAt: '2024-01-15T00:00:00.000Z',
    };
    const HOSTILE_FILTERS = {
      query: 'qq *zz* <i>w</i>',
      category: '*Cat* <b>',
      tags: ['<b>t</b>'],
    };
    const ALLOWED = ['h3', 'p', 'strong', 'code', 'ul', 'li', 'blockquote'];

    it('renders every upstream and caller string as the literal text structuredContent carries', async () => {
      mockDiscover.mockResolvedValue({ datasets: [HOSTILE_ENTRY], totalCount: 1 });
      const result = await runToolContract(discoverDatasets, HOSTILE_FILTERS);

      const structured = result.structuredContent as {
        datasets: Record<string, unknown>[];
        appliedFilters: unknown;
      };
      expect(structured.datasets[0]).toMatchObject({
        name: HOSTILE_ENTRY.name,
        description: HOSTILE_ENTRY.description,
        category: HOSTILE_ENTRY.category,
        tags: HOSTILE_ENTRY.tags,
        columnSample: HOSTILE_ENTRY.columnNames,
      });
      expect(structured.appliedFilters).toEqual(HOSTILE_FILTERS);

      const html = renderMarkdown(contentText(result));
      expect(strayElements(html, ALLOWED)).toEqual([]);
      expect(readBack(html.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? '')).toBe(HOSTILE_ENTRY.name);
      const text = readBack(html);
      expect(text).toContain('Category: *Cat* <b> |');
      expect(text).toContain(`\n${HOSTILE_ENTRY.description}\n`);
      expect(text).toContain('Tags: <b>t</b>, a_b, _x_');
      expect(text).toContain('Columns: 2 (_c_, data_value_type)');
      const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => readBack(m[1] ?? ''));
      expect(items).toEqual([
        'Query: "qq *zz* <i>w</i>"',
        'Category: "*Cat* <b>"',
        'Tags (any of): <b>t</b>',
      ]);
    });

    it.each(['# Heading', '-|-|-|-|-', '===', '---', '1. Item', '> Quote'])(
      'keeps a description opening %j a line of text under the metadata line',
      async (description) => {
        mockDiscover.mockResolvedValue({
          datasets: [{ ...HOSTILE_ENTRY, name: 'Plain', description }],
          totalCount: 1,
        });
        const result = await runToolContract(discoverDatasets, {});

        const html = renderMarkdown(contentText(result));
        expect(strayElements(html, ALLOWED)).toEqual([]);
        expect(html.match(/<blockquote>/g) ?? []).toHaveLength(0);
        expect(readBack(html)).toContain(`\n${description}\n`);
      },
    );

    it('renders an empty-page notice quoting the caller as one escaped blockquote', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const query = 'qq *zz* <i>w</i>\n\n# injected';
      const result = await runToolContract(discoverDatasets, { query });

      expect((result.structuredContent as { notice: string }).notice).toContain(`query "${query}"`);
      const html = renderMarkdown(contentText(result));
      expect(html).not.toContain('<h1>');
      const quote = html.match(/<blockquote>([\s\S]*?)<\/blockquote>/)?.[1] ?? '';
      expect(strayElements(quote, ['p'])).toEqual([]);
      expect(readBack(quote).replace(/\s+/g, ' ')).toContain(
        'No datasets found for query "qq *zz* <i>w</i> # injected"',
      );
    });
  });

  describe('description cut', () => {
    const describeAs = async (description: string) => {
      mockDiscover.mockResolvedValue({
        datasets: [{ id: 'ab12-cd34', name: 'Cut', description }],
        totalCount: 1,
      });
      const result = await runToolContract(discoverDatasets, {});
      const cut = (result.structuredContent as { datasets: { description?: string }[] }).datasets[0]
        ?.description;
      return { cut, html: renderMarkdown(contentText(result)) };
    };

    it('drops a URL the cut lands inside rather than linking to a truncated address', async () => {
      const lead = `${'x'.repeat(280)} see`;
      const { cut, html } = await describeAs(
        `${lead} https://www.iqvia.com/insights/the-iqvia-institute for details`,
      );
      expect(cut).toBe(`${lead}…`);
      expect(html).not.toContain('<a ');
    });

    it('keeps a URL the cut lands right after and sets the ellipsis off from it', async () => {
      const lead = `${'x'.repeat(274)} see `;
      const url = 'https://www.iqvia.com';
      expect(lead.length + url.length).toBe(300);
      const { cut, html } = await describeAs(`${lead}${url} and more text after it.`);

      expect(cut).toBe(`${lead}${url} …`);
      expect(html).toContain(`<a href="${url}">${url}</a>`);
      expect(html).not.toContain('%E2%80%A6');
    });

    it('drops a trailing tag the catalog cut open, before the description is measured', async () => {
      /** The Discovery API returns `jgk8-6dpn` cut mid-anchor at about 4,000 characters. */
      const { cut, html } = await describeAs(
        'The archived datasets can be found here: <a href="https://data.cdc.gov/Public-Health-Surveillance/United-States-COVID-19-County-Level-of-Community-T',
      );
      expect(cut).toBe('The archived datasets can be found here:');
      expect(html).not.toContain('href');
    });

    it('never splits a surrogate pair at the cut', async () => {
      const { cut } = await describeAs(`${'x'.repeat(299)}💩${'y'.repeat(50)}`);
      expect(cut).toBe(`${'x'.repeat(299)}…`);
    });

    it('cuts ordinary prose at the limit, as before', async () => {
      const { cut } = await describeAs('D'.repeat(500));
      expect(cut).toBe(`${'D'.repeat(300)}…`);
    });
  });

  describe('error contract', () => {
    it('declares invalid_query contract entry', () => {
      const entry = discoverDatasets.errors?.find((e) => e.reason === 'invalid_query');
      expect(entry).toBeDefined();
      expect(entry?.recovery).toContain('category names');
    });

    it('scopes upstream_error to 5xx and keeps it the only retryable non-429 failure', () => {
      /**
       * A 403 routed through upstream_error told callers to retry a permanent refusal.
       * Retryability now tracks the status band: 5xx and rate limiting recover, an access
       * decision and a caller-side range error do not.
       */
      const byReason = new Map<string, ErrorContract>(
        discoverDatasets.errors?.map((e) => [e.reason, e]),
      );
      expect(byReason.get('upstream_error')?.when).toContain('5xx');
      expect(byReason.get('upstream_error')?.retryable).toBe(true);
      expect(byReason.get('access_denied')?.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(byReason.get('access_denied')?.retryable).toBeUndefined();
      expect(byReason.get('page_out_of_range')?.retryable).toBeUndefined();
    });

    it('re-throws McpError through ctx.fail with the declared recovery filled', async () => {
      const serviceErr = new McpError(-32602, 'Invalid filter value', {
        reason: 'invalid_query',
      });
      mockDiscover.mockRejectedValue(serviceErr);

      const err = await contractError(discoverDatasets, { category: 'Bad Category!' });
      expect(err.data).toMatchObject({
        reason: 'invalid_query',
        recovery: { hint: expect.stringContaining('category names') },
      });
    });

    it('re-throws non-McpError errors unchanged', async () => {
      const plainErr = new Error('network failure');
      mockDiscover.mockRejectedValue(plainErr);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({});

      await expect(discoverDatasets.handler(input, ctx)).rejects.toThrow('network failure');
    });
  });
});
