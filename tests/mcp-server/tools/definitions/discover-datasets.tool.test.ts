/**
 * @fileoverview Tests for cdc_discover_datasets tool.
 * @module tests/mcp-server/tools/definitions/discover-datasets
 */

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
      const blocks = discoverDatasets.format!({ datasets: sampleServiceResult.datasets });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('bi63-dtpu');
      expect(text).toContain('Diabetes Mortality');
      expect(text).toContain('NCHS');
      expect(text).toContain('`state` (text), `year` (number), `deaths` (number)');
    });

    it('renders empty-state message when no datasets', () => {
      const blocks = discoverDatasets.format!({ datasets: [] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No datasets matched');
    });

    it('renders all columns without truncation', () => {
      const cols = Array.from({ length: 15 }, (_, i) => `col_${i}`);
      const blocks = discoverDatasets.format!({
        datasets: [{ ...sampleServiceResult.datasets[0], columnNames: cols }],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('`col_0` (text)');
      expect(text).toContain('`col_14` (unknown)');
    });
  });
});
