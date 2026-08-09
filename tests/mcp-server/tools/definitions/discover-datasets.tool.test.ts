/**
 * @fileoverview Tests for cdc_discover_datasets tool.
 * @module tests/mcp-server/tools/definitions/discover-datasets
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ discover: mockDiscover }),
}));

const sampleServiceResult: DiscoverResult = {
  datasets: [
    {
      id: 'bi63-dtpu',
      name: 'Diabetes Mortality',
      description: 'State-level diabetes death rates',
      category: 'NCHS',
      tags: ['diabetes', 'mortality'],
      columnNames: ['state', 'year', 'deaths'],
      columnTypes: ['text', 'number', 'number'],
      updatedAt: '2024-01-15T00:00:00.000Z',
      pageViews: 5000,
    },
  ],
  totalCount: 1,
};

describe('cdc_discover_datasets', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns datasets for a valid query', async () => {
    mockDiscover.mockResolvedValue(sampleServiceResult);
    const ctx = createMockContext();
    const input = discoverDatasets.input.parse({ query: 'diabetes' });
    const result = await discoverDatasets.handler(input, ctx);

    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0].id).toBe('bi63-dtpu');
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
    const ctx = createMockContext();
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
          ...sampleServiceResult.datasets[0],
          columnNames: wideColumns,
          columnTypes: wideColumns.map(() => 'text'),
        },
      ],
      totalCount: 1,
    });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

    const description = (result.datasets[0] as { description: string }).description;
    expect(description.endsWith('…')).toBe(true);
    expect(description.length).toBe(301); // 300 chars + ellipsis
  });

  it('threads the domain through to the service', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = discoverDatasets.input.parse({ query: 'diabetes', category: 'NCHS' });
    await discoverDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.appliedFilters).toEqual({ query: 'diabetes', category: 'NCHS' });
    expect(enrichment.notice).toBeUndefined();
  });

  it('emits a notice when no datasets matched', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
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
      const rendered = discoverDatasets.enrichmentTrailer.appliedFilters.render({
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
      const trailer = discoverDatasets.enrichment.appliedFilters.description ?? '';
      expect(trailer).toContain('multiple tags union');

      const tagsField = discoverDatasets.enrichment.appliedFilters.shape.tags.description ?? '';
      expect(tagsField).toContain('any one of them');
    });

    it('points a tag-filtered no-match at the catalog vocabulary', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const ctx = createMockContext();
      await discoverDatasets.handler(
        discoverDatasets.input.parse({ tags: ['covid19', 'zzzznotag'] }),
        ctx,
      );

      const notice = getEnrichment(ctx).notice as string;
      // The criteria echo has to read as a union too, or it contradicts the guidance.
      expect(notice).toContain('any of tags [covid19, zzzznotag]');
      expect(notice).toContain('check the spelling against the tags field');
    });

    it('leaves the vocabulary hint out of a no-match that used no tags', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const ctx = createMockContext();
      await discoverDatasets.handler(discoverDatasets.input.parse({ query: 'nonexistent' }), ctx);

      expect(getEnrichment(ctx).notice).not.toContain('check the spelling against the tags field');
    });
  });

  it('emits a notice with no criteria when no filters applied', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
    const input = discoverDatasets.input.parse({});
    await discoverDatasets.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No datasets found');
    expect(enrichment.appliedFilters).toEqual({});
  });

  it('passes all options to the service', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
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
      expect(blocks[0].type).toBe('text');
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
      const byReason = new Map(discoverDatasets.errors?.map((e) => [e.reason, e]));
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
