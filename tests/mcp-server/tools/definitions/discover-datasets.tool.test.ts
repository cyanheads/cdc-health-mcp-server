/**
 * @fileoverview Tests for cdc_discover_datasets tool.
 * @module tests/mcp-server/tools/definitions/discover-datasets
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

const sampleResult = {
  ...sampleServiceResult,
  appliedFilters: { query: 'diabetes' },
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
    expect(result.totalCount).toBe(1);
    expect(result.datasets[0].id).toBe('bi63-dtpu');
    expect(result.appliedFilters).toEqual({ query: 'diabetes' });
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
      const blocks = discoverDatasets.format!(sampleResult);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('1 datasets found');
      expect(text).toContain('bi63-dtpu');
      expect(text).toContain('Diabetes Mortality');
      expect(text).toContain('NCHS');
      expect(text).toContain('`state` (text), `year` (number), `deaths` (number)');
    });

    it('renders empty-state message with criteria echo', () => {
      const blocks = discoverDatasets.format!({
        datasets: [],
        totalCount: 0,
        appliedFilters: { query: 'nonexistent' },
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No datasets found');
      expect(text).toContain('nonexistent');
    });

    it('renders empty-state message without filters', () => {
      const blocks = discoverDatasets.format!({
        datasets: [],
        totalCount: 0,
        appliedFilters: {},
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No datasets found');
    });

    it('truncates long descriptions', () => {
      const longDesc = { ...sampleResult };
      longDesc.datasets = [{ ...sampleResult.datasets[0], description: 'x'.repeat(400) }];
      const blocks = discoverDatasets.format!(longDesc);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('...');
    });

    it('renders all columns without truncation', () => {
      const manyColumns = { ...sampleResult };
      const cols = Array.from({ length: 15 }, (_, i) => `col_${i}`);
      manyColumns.datasets = [{ ...sampleResult.datasets[0], columnNames: cols }];
      const blocks = discoverDatasets.format!(manyColumns);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('`col_0` (text)');
      expect(text).toContain('`col_14` (unknown)');
    });
  });
});
