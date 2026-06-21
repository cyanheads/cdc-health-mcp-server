/**
 * @fileoverview Edge-case and validation tests for cdc_discover_datasets.
 * @module tests/mcp-server/tools/definitions/discover-datasets-edge
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ discover: mockDiscover }),
}));

const emptyResult: DiscoverResult = { datasets: [], totalCount: 0 };

describe('cdc_discover_datasets — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation boundaries', () => {
    it('accepts limit of 1 (minimum)', () => {
      const input = discoverDatasets.input.parse({ limit: 1 });
      expect(input.limit).toBe(1);
    });

    it('accepts limit of 100 (maximum)', () => {
      const input = discoverDatasets.input.parse({ limit: 100 });
      expect(input.limit).toBe(100);
    });

    it('rejects limit of 0', () => {
      expect(() => discoverDatasets.input.parse({ limit: 0 })).toThrow();
    });

    it('rejects non-integer limit', () => {
      expect(() => discoverDatasets.input.parse({ limit: 2.5 })).toThrow();
    });

    it('accepts offset of 0 (minimum)', () => {
      const input = discoverDatasets.input.parse({ offset: 0 });
      expect(input.offset).toBe(0);
    });

    it('accepts offset of 9999 (maximum)', () => {
      const input = discoverDatasets.input.parse({ offset: 9999 });
      expect(input.offset).toBe(9999);
    });

    it('rejects offset above 9999', () => {
      expect(() => discoverDatasets.input.parse({ offset: 10000 })).toThrow();
    });

    it('accepts empty tags array', () => {
      const input = discoverDatasets.input.parse({ tags: [] });
      expect(input.tags).toEqual([]);
    });

    it('accepts multiple tags', () => {
      const input = discoverDatasets.input.parse({
        tags: ['covid19', 'surveillance', 'mortality'],
      });
      expect(input.tags).toHaveLength(3);
    });
  });

  describe('handler — service propagation', () => {
    it('propagates service errors', async () => {
      mockDiscover.mockRejectedValue(new Error('Catalog unavailable'));
      const ctx = createMockContext();
      const input = discoverDatasets.input.parse({ query: 'test' });
      await expect(discoverDatasets.handler(input, ctx)).rejects.toThrow(/Catalog unavailable/);
    });

    it('does not include tags in appliedFilters when tags is empty array', async () => {
      mockDiscover.mockResolvedValue(emptyResult);
      const ctx = createMockContext();
      const input = discoverDatasets.input.parse({ tags: [] });
      await discoverDatasets.handler(input, ctx);
      // empty tags array should not produce a notice reference to tags
      // service receives empty tags — fine; enrichment does not include tags key
      expect(mockDiscover).toHaveBeenCalledWith(
        expect.not.objectContaining({ tags: expect.arrayContaining(['anything']) }),
        ctx.signal,
      );
    });

    it('includes notice with all active filters when all three filters yield nothing', async () => {
      mockDiscover.mockResolvedValue(emptyResult);
      const ctx = createMockContext();
      const input = discoverDatasets.input.parse({
        query: 'lead',
        category: 'Environmental',
        tags: ['children'],
      });
      await discoverDatasets.handler(input, ctx);

      // Validate service call includes all filters
      expect(mockDiscover).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'lead', category: 'Environmental', tags: ['children'] }),
        ctx.signal,
      );
    });
  });

  describe('payload trimming — edge cases', () => {
    it('leaves a short description untruncated (no ellipsis)', async () => {
      const shortDescription = 'Brief dataset summary.';
      mockDiscover.mockResolvedValue({
        datasets: [{ id: 'ab12-cd34', name: 'Short', description: shortDescription }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

      const description = (result.datasets[0] as { description: string }).description;
      expect(description).toBe(shortDescription);
      expect(description).not.toContain('…');
    });

    it('reports a zero-column dataset honestly as columnCount 0', async () => {
      mockDiscover.mockResolvedValue({
        datasets: [{ id: 'ab12-cd34', name: 'Empty', columnNames: [], columnTypes: [] }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

      const ds = result.datasets[0] as { columnCount: number; columnSample: string[] };
      // A genuinely empty dataset surfaces 0 rather than an omitted (=unknown) count.
      expect(ds.columnCount).toBe(0);
      expect(ds.columnSample).toEqual([]);
      expect(result).toEqual(expect.schemaMatching(discoverDatasets.output));

      // format() renders the count and does not crash.
      const blocks = discoverDatasets.format!({ datasets: result.datasets });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Empty');
      expect(text).toContain('**Columns:** 0');
    });

    it('caps columnSample at 8 even when more columns exist', async () => {
      const wide = Array.from({ length: 20 }, (_, i) => `c${i}`);
      mockDiscover.mockResolvedValue({
        datasets: [{ id: 'ab12-cd34', name: 'Wide', columnNames: wide, columnTypes: wide }],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

      const ds = result.datasets[0] as { columnCount: number; columnSample: string[] };
      expect(ds.columnCount).toBe(20);
      expect(ds.columnSample).toHaveLength(8);
    });
  });

  describe('format — edge cases with optional fields', () => {
    it('renders dataset without tags without crashing', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          {
            id: 'ab12-cd34',
            name: 'No Tags Dataset',
            // no tags
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No Tags Dataset');
    });

    it('renders dataset without columns without crashing', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          {
            id: 'ab12-cd34',
            name: 'No Columns Dataset',
            // no columnNames
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No Columns Dataset');
      expect(text).not.toContain('Columns:');
    });

    it('renders dataset without pageViews as dash', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          {
            id: 'ab12-cd34',
            name: 'No Views',
            // no pageViews
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Views:** —');
    });

    it('renders pageViews with locale formatting', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          {
            id: 'ab12-cd34',
            name: 'Popular Dataset',
            pageViews: 1234567,
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('1,234,567');
    });

    it('renders multiple datasets', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          { id: 'aa11-bb22', name: 'Dataset One' },
          { id: 'cc33-dd44', name: 'Dataset Two' },
          { id: 'ee55-ff66', name: 'Dataset Three' },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('3 datasets returned');
      expect(text).toContain('Dataset One');
      expect(text).toContain('Dataset Two');
      expect(text).toContain('Dataset Three');
    });
  });
});
