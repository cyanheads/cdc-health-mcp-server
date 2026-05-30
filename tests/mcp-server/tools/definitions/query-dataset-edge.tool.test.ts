/**
 * @fileoverview Edge-case tests for cdc_query_dataset: format variants, boundary validation.
 * @module tests/mcp-server/tools/definitions/query-dataset-edge
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import type { QueryResult } from '@/services/socrata/types.js';

const mockQuery = vi.fn<() => Promise<QueryResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ query: mockQuery }),
}));

describe('cdc_query_dataset — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation — additional boundaries', () => {
    it('defaults offset to 0', () => {
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34' });
      expect(input.offset).toBe(0);
    });

    it('accepts offset > 0', () => {
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', offset: 500 });
      expect(input.offset).toBe(500);
    });

    it('accepts all optional SoQL fields as undefined', () => {
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34' });
      expect(input.search).toBeUndefined();
      expect(input.select).toBeUndefined();
      expect(input.where).toBeUndefined();
      expect(input.group).toBeUndefined();
      expect(input.having).toBeUndefined();
      expect(input.order).toBeUndefined();
    });

    it('rejects non-integer limit', () => {
      expect(() => queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 1.5 })).toThrow();
    });
  });

  describe('handler — edge cases', () => {
    it('propagates service errors', async () => {
      mockQuery.mockRejectedValue(new Error('No such column "badcol"'));
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: "badcol='x'" });
      await expect(queryDataset.handler(input, ctx)).rejects.toThrow(/badcol/);
    });

    it('emits effectiveQuery as enrichment for zero-row result', async () => {
      const emptyQueryStr = '$where=year%3D2020&$limit=100&$offset=0';
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: emptyQueryStr });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: 'year=2020' });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe(emptyQueryStr);
    });

    it('does NOT include query in output object (only in enrichment)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100' });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34' });
      const result = await queryDataset.handler(input, ctx);
      expect((result as Record<string, unknown>).query).toBeUndefined();
    });

    it('large result set: rowCount matches rows length', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => ({
        id: String(i),
        state: 'California',
      }));
      mockQuery.mockResolvedValue({ rows, rowCount: 500, query: '$limit=500' });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 500 });
      const result = await queryDataset.handler(input, ctx);
      expect(result.rowCount).toBe(500);
      expect(result.rows).toHaveLength(500);
    });
  });

  describe('format — additional edge cases', () => {
    it('renders single row correctly', () => {
      const blocks = queryDataset.format!({
        rows: [{ state: 'Alaska', deaths: '42' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('1 rows returned');
      expect(text).toContain('Alaska');
      expect(text).toContain('42');
    });

    it('handles row where value contains a newline', () => {
      const blocks = queryDataset.format!({
        rows: [{ note: 'line1\nline2', id: '1' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // newlines in cell values should be collapsed to spaces
      expect(text).toContain('line1 line2');
    });

    it('handles row where value is a number (not string)', () => {
      const blocks = queryDataset.format!({
        rows: [{ count: 42, label: 'test' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // non-string values use JSON.stringify
      expect(text).toContain('42');
    });

    it('empty-state message includes suggestions', () => {
      const blocks = queryDataset.format!({ rows: [], rowCount: 0 });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No rows matched the query');
      expect(text).toContain('Suggestions');
    });
  });
});
