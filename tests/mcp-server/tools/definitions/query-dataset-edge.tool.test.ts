/**
 * @fileoverview Edge-case tests for cdc_query_dataset: format variants, boundary validation.
 * @module tests/mcp-server/tools/definitions/query-dataset-edge
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

    it('accepts offset at the ceiling (1,000,000)', () => {
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', offset: 1_000_000 });
      expect(input.offset).toBe(1_000_000);
    });

    it('rejects offset above the ceiling (1,000,001)', () => {
      const result = queryDataset.input.safeParse({ datasetId: 'bi63-dtpu', offset: 1_000_001 });
      expect(result.success).toBe(false);
    });

    it('rejects a pathological max-safe-integer offset', () => {
      const result = queryDataset.input.safeParse({
        datasetId: 'bi63-dtpu',
        offset: Number.MAX_SAFE_INTEGER,
      });
      expect(result.success).toBe(false);
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
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: "badcol='x'" });
      await expect(queryDataset.handler(input, ctx)).rejects.toThrow(/badcol/);
    });

    it('emits effectiveQuery as enrichment for zero-row result', async () => {
      const emptyQueryStr = '$where=year%3D2020&$limit=100&$offset=0';
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: emptyQueryStr, hasMore: false });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: 'year=2020' });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.effectiveQuery).toBe(emptyQueryStr);
    });

    it('does NOT include query in output object (only in enrichment)', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100', hasMore: false });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34' });
      const result = await queryDataset.handler(input, ctx);
      expect((result as Record<string, unknown>).query).toBeUndefined();
    });

    it('large result set: rowCount matches rows length', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => ({
        id: String(i),
        state: 'California',
      }));
      mockQuery.mockResolvedValue({ rows, rowCount: 500, query: '$limit=500', hasMore: false });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 500 });
      const result = await queryDataset.handler(input, ctx);
      expect(result.rowCount).toBe(500);
      expect(result.rows).toHaveLength(500);
    });
  });

  describe('handler — truncation notice', () => {
    it('emits a truncation notice when the probe found a further row', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ state: 'CA' }],
        rowCount: 1,
        query: '$limit=100',
        hasMore: true,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 100 });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('More rows');
      expect(enrichment.notice).toContain('offset=1');
      expect(enrichment.notice).toContain('order');
    });

    it('does not emit a truncation notice when no further row exists', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ state: 'CA' }],
        rowCount: 1,
        query: '$limit=100',
        hasMore: false,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 100 });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
    });

    it('does not emit truncation notice for empty results', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100', hasMore: false });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 100 });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toContain('No rows matched');
    });
  });

  describe('handler — response budget', () => {
    /** A row roughly the width of akvg-8vrb's 38 columns (~1.2 KB serialized). */
    const wideRow = (i: number) =>
      Object.fromEntries(
        Array.from({ length: 38 }, (_, c) => [`col_${c}`, `${i}-${'v'.repeat(28)}`]),
      );

    it('bounds a 5000-row page by serialized size and reports how far it got', async () => {
      const rows = Array.from({ length: 5000 }, (_, i) => wideRow(i));
      mockQuery.mockResolvedValue({
        rows,
        rowCount: 5000,
        query: '$limit=5000&$offset=0',
        hasMore: false,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'akvg-8vrb', limit: 5000 });
      const result = await queryDataset.handler(input, ctx);

      expect(result.rowCount).toBeLessThan(5000);
      expect(result.rowCount).toBe(result.rows.length);
      expect(JSON.stringify(result.rows).length).toBeLessThanOrEqual(200_000);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(result.rowCount);
      expect(enrichment.cap).toBe(5000);
      expect(enrichment.nextOffset).toBe(result.rowCount);
      expect(enrichment.notice).toMatch(/response size budget/i);
    });

    it('bounds content[] alongside structuredContent at the same cut', async () => {
      const rows = Array.from({ length: 5000 }, (_, i) => wideRow(i));
      mockQuery.mockResolvedValue({
        rows,
        rowCount: 5000,
        query: '$limit=5000&$offset=0',
        hasMore: false,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'akvg-8vrb', limit: 5000 });
      const result = await queryDataset.handler(input, ctx);

      const text = (queryDataset.format!(result)[0] as { type: 'text'; text: string }).text;
      expect(new TextEncoder().encode(text).length).toBeLessThan(200_000);
    });

    it('keeps one row when a single row is larger than the whole budget', async () => {
      const monster = { blob: 'x'.repeat(300_000) };
      mockQuery.mockResolvedValue({
        rows: [monster, { blob: 'y' }],
        rowCount: 2,
        query: '$limit=2&$offset=0',
        hasMore: false,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 2 });
      const result = await queryDataset.handler(input, ctx);

      expect(result.rows).toHaveLength(1);
      expect(getEnrichment(ctx).notice).not.toContain('No rows matched');
      expect(getEnrichment(ctx).truncated).toBe(true);
    });

    it('leaves an ordinary page untouched', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
      mockQuery.mockResolvedValue({
        rows,
        rowCount: 100,
        query: '$limit=100&$offset=0',
        hasMore: false,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34' });
      const result = await queryDataset.handler(input, ctx);

      expect(result.rows).toHaveLength(100);
      expect(getEnrichment(ctx).truncated).toBeUndefined();
    });
  });

  describe('handler — nextOffset boundaries', () => {
    it('omits nextOffset when the next page would land past the offset ceiling', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ state: 'CA' }],
        rowCount: 1,
        query: '$limit=1&$offset=1000000',
        hasMore: true,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({
        datasetId: 'ab12-cd34',
        limit: 1,
        offset: 1_000_000,
      });
      await queryDataset.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toContain('1,000,000');
    });

    it('walks a result set to exhaustion by replaying nextOffset', async () => {
      /**
       * Past the first page: each call must resume where the last stopped and the walk must
       * end on the page the probe finds no successor for — not one page early, not looping.
       */
      const all = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }));
      mockQuery.mockImplementation(((options: { limit: number; offset: number }) => {
        const page = all.slice(options.offset, options.offset + options.limit);
        return Promise.resolve({
          rows: page,
          rowCount: page.length,
          query: `$limit=${options.limit}&$offset=${options.offset}`,
          hasMore: options.offset + page.length < all.length,
        });
      }) as unknown as () => Promise<QueryResult>);

      const seen: string[] = [];
      let offset: number | undefined = 0;
      let calls = 0;
      while (offset !== undefined) {
        calls++;
        const ctx = createMockContext({ errors: queryDataset.errors });
        const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 3, offset });
        const page = await queryDataset.handler(input, ctx);
        seen.push(...page.rows.map((r) => r.id as string));
        offset = getEnrichment(ctx).nextOffset as number | undefined;
      }

      expect(seen).toEqual(['0', '1', '2', '3', '4', '5', '6']);
      expect(calls).toBe(3);
    });

    it('carries the caller offset into nextOffset rather than restarting at zero', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ a: '1' }, { a: '2' }],
        rowCount: 2,
        query: '$limit=2&$offset=400',
        hasMore: true,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 2, offset: 400 });
      await queryDataset.handler(input, ctx);

      expect(getEnrichment(ctx).nextOffset).toBe(402);
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

    it('surfaces a service 403 as Forbidden with a recovery that does not promise a retry', async () => {
      /**
       * Querying a non-tabular asset ID answers 403. Reported as upstream_error it came
       * back as a retryable ServiceUnavailable claiming data.cdc.gov might be down, so a
       * caller burned retries against a decision that never changes.
       */
      const serviceErr = new McpError(
        JsonRpcErrorCode.Forbidden,
        'Socrata denied access to this resource (403): no row or column access to non-tabular tables.',
        { reason: 'access_denied' },
      );
      mockQuery.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: '235m-gsry', limit: 2 });

      const err = (await Promise.resolve(queryDataset.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
      const data = err.data as { reason: string; retryable?: boolean; recovery: { hint: string } };
      expect(data.reason).toBe('access_denied');
      expect(data.retryable).toBeUndefined();
      expect(data.recovery.hint).toContain('cdc_get_dataset_schema');
      expect(data.recovery.hint).not.toMatch(/temporarily unavailable|retry after/i);
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

    it('renders columns that first appear in a later row (sparse rows)', () => {
      // row 0 lacks the footnote field; it appears only in row 1. The union-of-keys
      // column derivation must keep it in the header so content[] does not drop data.
      const blocks = queryDataset.format!({
        rows: [
          { stateabbr: 'CA', data_value: '1.2' },
          { stateabbr: 'TX', data_value: '3.4', data_value_footnote: 'suppressed' },
        ],
        rowCount: 2,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      const lines = text.split('\n');
      const headerLine = lines.find((l) => l.startsWith('| stateabbr'))!;
      const caRow = lines.find((l) => l.startsWith('| CA'))!;
      const pipeCount = (s: string) => (s.match(/\|/g) ?? []).length;

      // Late-appearing column present in the header...
      expect(headerLine).toContain('data_value_footnote');
      // ...the earlier row renders a cell for every column (trailing empty cell)...
      expect(pipeCount(caRow)).toBe(pipeCount(headerLine));
      // ...and the later row's value is still rendered.
      expect(text).toContain('suppressed');
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

  describe('input schema — order description', () => {
    it('order description names :id as the minimum tie-breaker for offset pagination', () => {
      /**
       * SODA does not order results implicitly, so an offset walk without an ORDER BY can
       * skip or repeat rows. `:id` is a system field on every dataset, which is what makes
       * it usable by a caller who knows no unique column.
       */
      const desc = queryDataset.input.shape.order.description ?? '';
      expect(desc).toMatch(/deterministic|stable/i);
      expect(desc).toContain(':id');
    });
  });

  describe('enrichment schema — nextOffset', () => {
    it('says nextOffset only appears when a further page exists', () => {
      const desc = queryDataset.enrichment?.nextOffset.description ?? '';
      expect(desc).toContain('offset');
      expect(desc).toMatch(/only when|present only/i);
    });
  });
});
