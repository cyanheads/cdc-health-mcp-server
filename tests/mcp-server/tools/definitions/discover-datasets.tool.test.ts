/**
 * @fileoverview Tests for cdc_discover_datasets tool.
 * @module tests/mcp-server/tools/definitions/discover-datasets
 */

import { type ErrorContract, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import type { CatalogDataset, DiscoverResult, VocabularyTerm } from '@/services/socrata/types.js';

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

  it('rejects limit above 100', () => {
    expect(() => discoverDatasets.input.parse({ limit: 101 })).toThrow();
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

    it('re-throws McpError with ctx.fail and recoveryFor when reason is declared', async () => {
      const serviceErr = new McpError(-32602, 'Invalid filter value', {
        reason: 'invalid_query',
      });
      mockDiscover.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ category: 'Bad Category!' });

      await expect(discoverDatasets.handler(input, ctx)).rejects.toMatchObject({
        data: expect.objectContaining({
          reason: 'invalid_query',
          recovery: { hint: expect.stringContaining('category names') },
        }),
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
