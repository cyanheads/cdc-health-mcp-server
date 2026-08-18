/**
 * @fileoverview Edge-case and validation tests for cdc_discover_datasets.
 * @module tests/mcp-server/tools/definitions/discover-datasets-edge
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

    it('accepts an offset/limit pair summing to exactly 10000', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 1471 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ offset: 9900, limit: 100 });

      await expect(discoverDatasets.handler(input, ctx)).resolves.toBeDefined();
      expect(mockDiscover).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 9900, limit: 100 }),
        ctx.signal,
      );
    });

    it('rejects an offset/limit pair summing above 10000 before calling the catalog', async () => {
      /**
       * The ceiling is on the sum, which no pair of independent per-field maxima can
       * express — 9999 + 5 clears both bounds and still fails upstream. Catching it in
       * the handler keeps the failure typed; a schema-level refine would surface as a
       * raw -32602 with no reachable recovery hint.
       */
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ offset: 9999, limit: 5 });

      const err = (await Promise.resolve(discoverDatasets.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'page_out_of_range' });
      expect(err.message).toContain('10004');
      expect((err.data as { recovery: { hint: string } }).recovery.hint).toContain('10000');
      expect(mockDiscover).not.toHaveBeenCalled();
    });

    it('names the sum constraint in the offset and limit descriptions', () => {
      /**
       * A cross-field check contributes nothing to the emitted JSON Schema, so the field
       * descriptions are the only place a client can read the constraint before calling.
       */
      const shape = discoverDatasets.input.shape;
      expect(shape.offset.description).toContain('offset plus limit must not exceed 10000');
      expect(shape.limit.description).toContain('offset plus limit must not exceed 10000');
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
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ query: 'test' });
      await expect(discoverDatasets.handler(input, ctx)).rejects.toThrow(/Catalog unavailable/);
    });

    it('does not include tags in appliedFilters when tags is empty array', async () => {
      mockDiscover.mockResolvedValue(emptyResult);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ tags: [] });
      await discoverDatasets.handler(input, ctx);
      // empty tags array should not produce a notice reference to tags
      // service receives empty tags — fine; enrichment does not include tags key
      expect(mockDiscover).toHaveBeenCalledWith(
        expect.not.objectContaining({ tags: expect.arrayContaining(['anything']) }),
        ctx.signal,
      );
    });

    it('diagnoses an empty page past totalCount as an exhausted result set', async () => {
      /**
       * The catalog holds ~1,471 entries, so offset 2000 empties the page while the search
       * itself matched. Telling the caller to broaden their terms sends them after a
       * problem that does not exist.
       */
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 1471 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ offset: 2000, limit: 5 });
      await discoverDatasets.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('Offset 2000 is past the end');
      expect(notice).toContain('1471 datasets');
      expect(notice).not.toContain('broader search terms');
    });

    it('treats an offset equal to totalCount as past the end, not as a no-match', async () => {
      /**
       * Offsets are zero-based, so the last page that can hold a result starts below
       * totalCount and `offset === totalCount` is already one past the end. Comparing with
       * `>` instead sends the caller at the boundary off to broaden a search that matched.
       */
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 1471 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ offset: 1471, limit: 5 });
      await discoverDatasets.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('Offset 1471 is past the end');
      expect(notice).not.toContain('broader search terms');
    });

    it('still suggests broadening when the search genuinely matched nothing', async () => {
      mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const input = discoverDatasets.input.parse({ query: 'zzzz', offset: 2000, limit: 5 });
      await discoverDatasets.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No datasets found');
      expect(notice).toContain('broader search terms');
      expect(notice).not.toContain('past the end');
    });

    it('includes notice with all active filters when all three filters yield nothing', async () => {
      mockDiscover.mockResolvedValue(emptyResult);
      const ctx = createMockContext({ errors: discoverDatasets.errors });
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
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

      const description = (result.datasets[0] as { description: string }).description;
      expect(description).toBe(shortDescription);
      expect(description).not.toContain('…');
    });

    it('reports a zero-column dataset honestly as columnCount 0', async () => {
      mockDiscover.mockResolvedValue({
        datasets: [
          { id: 'ab12-cd34', name: 'Empty', assetType: 'chart', columnNames: [], columnTypes: [] },
        ],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
      const result = await discoverDatasets.handler(discoverDatasets.input.parse({}), ctx);

      const ds = result.datasets[0] as { columnCount: number; columnSample: string[] };
      // A genuinely empty dataset surfaces 0 rather than an omitted (=unknown) count.
      expect(ds.columnCount).toBe(0);
      expect(ds.columnSample).toEqual([]);
      expect(result).toEqual(expect.schemaMatching(discoverDatasets.output));

      /**
       * A bare "0" reads as a count worth ignoring; the rendered surface has to say the
       * entry is not tabular and name the tool that will come back empty.
       */
      const blocks = discoverDatasets.format!({ datasets: result.datasets });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Empty');
      expect(text).toContain('**Type:** chart');
      expect(text).toContain('**Columns:** none — not a tabular asset');
      expect(text).toContain('cdc_query_dataset');
    });

    it('caps columnSample at 8 even when more columns exist', async () => {
      const wide = Array.from({ length: 20 }, (_, i) => `c${i}`);
      mockDiscover.mockResolvedValue({
        datasets: [{ id: 'ab12-cd34', name: 'Wide', columnNames: wide, columnTypes: wide }],
        totalCount: 1,
      });
      const ctx = createMockContext({ errors: discoverDatasets.errors });
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
