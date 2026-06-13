/**
 * @fileoverview Edge-case tests for cdc_query_dataset: format variants, boundary validation.
 * @module tests/mcp-server/tools/definitions/query-dataset-edge
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
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

  describe('handler — truncation notice', () => {
    it('emits truncation notice when rowCount equals limit', async () => {
      mockQuery.mockResolvedValue({ rows: [{ state: 'CA' }], rowCount: 100, query: '$limit=100' });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 100 });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('truncated');
      expect(enrichment.notice).toContain('100');
      expect(enrichment.notice).toContain('offset');
    });

    it('does not emit truncation notice when rowCount is less than limit', async () => {
      mockQuery.mockResolvedValue({ rows: [{ state: 'CA' }], rowCount: 50, query: '$limit=100' });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 100 });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
    });

    it('does not emit truncation notice for empty results', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100' });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 100 });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('No rows matched');
    });
  });

  describe('handler — service error re-throw with recovery', () => {
    it('re-throws McpError with ctx.fail and recoveryFor when reason is declared', async () => {
      const serviceErr = new McpError(-32602, 'No such column "badcol"', {
        reason: 'no_such_column',
        column: 'badcol',
      });
      mockQuery.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: "badcol='x'" });

      await expect(queryDataset.handler(input, ctx)).rejects.toMatchObject({
        data: expect.objectContaining({
          reason: 'no_such_column',
          recovery: { hint: expect.stringContaining('cdc_get_dataset_schema') },
        }),
      });
    });

    it('re-throws non-McpError errors unchanged', async () => {
      const plainErr = new Error('network failure');
      mockQuery.mockRejectedValue(plainErr);
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34' });

      await expect(queryDataset.handler(input, ctx)).rejects.toThrow('network failure');
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

    it('non-empty result includes schema tip', () => {
      const blocks = queryDataset.format!({
        rows: [{ state: 'Alaska', deaths: '42' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('cdc_get_dataset_schema');
    });
  });

  describe('input schema — datasetId description', () => {
    it('datasetId description includes cdc_discover_datasets pointer', () => {
      const shape = queryDataset.input.shape;
      const desc = shape.datasetId.description;
      expect(desc).toContain('cdc_discover_datasets');
    });
  });

  describe('input schema — where description', () => {
    it('where description includes reserved-word backtick-escape guidance', () => {
      const desc = queryDataset.input.shape.where.description;
      expect(desc).toMatch(/backtick/i);
      expect(desc).toContain('group');
    });
  });
});
