/**
 * @fileoverview Tests for cdc_discover_datasets tool.
 * @module tests/mcp-server/tools/definitions/discover-datasets
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
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

    it('upstream_error description excludes 400 from catch-all', () => {
      const entry = discoverDatasets.errors?.find((e) => e.reason === 'upstream_error');
      expect(entry?.when).toContain('400/404/429');
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
