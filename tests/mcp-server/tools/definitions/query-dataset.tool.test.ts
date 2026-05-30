/**
 * @fileoverview Tests for cdc_query_dataset tool.
 * @module tests/mcp-server/tools/definitions/query-dataset
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import type { QueryResult } from '@/services/socrata/types.js';

const mockQuery = vi.fn<() => Promise<QueryResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ query: mockQuery }),
}));

const sampleResult: QueryResult = {
  rows: [
    { state: 'California', year: '2020', deaths: '5000' },
    { state: 'Texas', year: '2020', deaths: '4500' },
  ],
  rowCount: 2,
  query: '$where=year%3D2020&$limit=100',
};

describe('cdc_query_dataset', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns rows and rowCount for valid input', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = queryDataset.input.parse({
      datasetId: 'bi63-dtpu',
      where: 'year=2020',
    });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    // query is now enrichment, not output
    expect((result as Record<string, unknown>).query).toBeUndefined();
  });

  it('enriches with effectiveQuery', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'year=2020' });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('where');
    expect(enrichment.notice).toBeUndefined();
  });

  it('emits a notice when no rows matched', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$where=x' });
    const ctx = createMockContext();
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1' });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No rows matched');
    expect(enrichment.effectiveQuery).toBe('$where=x');
  });

  it('passes all SoQL clauses to the service', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '' });
    const ctx = createMockContext();
    const input = queryDataset.input.parse({
      datasetId: 'bi63-dtpu',
      search: 'diabetes',
      select: 'state, sum(deaths)',
      where: "year='2020'",
      group: 'state',
      having: 'sum(deaths) > 100',
      order: 'sum(deaths) DESC',
      limit: 500,
      offset: 10,
    });
    await queryDataset.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetId: 'bi63-dtpu',
        search: 'diabetes',
        select: 'state, sum(deaths)',
        where: "year='2020'",
        group: 'state',
        having: 'sum(deaths) > 100',
        order: 'sum(deaths) DESC',
        limit: 500,
        offset: 10,
      }),
      ctx.signal,
    );
  });

  it('allows query with no filters', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100' });
    const ctx = createMockContext();
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu' });
    const result = await queryDataset.handler(input, ctx);
    expect(result.rowCount).toBe(0);
  });

  it('rejects invalid dataset ID in schema', () => {
    expect(() => queryDataset.input.parse({ datasetId: 'bad', where: 'x=1' })).toThrow();
  });

  it('applies default limit of 100', () => {
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1' });
    expect(input.limit).toBe(100);
  });

  it('rejects limit above 5000', () => {
    expect(() =>
      queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1', limit: 5001 }),
    ).toThrow();
  });

  describe('format', () => {
    it('renders a markdown table', () => {
      const blocks = queryDataset.format!({ rows: sampleResult.rows, rowCount: 2 });
      expect(blocks).toHaveLength(1);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('2 rows returned');
      expect(text).toContain('| state | year | deaths |');
      expect(text).toContain('California');
      expect(text).toContain('Texas');
    });

    it('renders empty-state message', () => {
      const blocks = queryDataset.format!({ rows: [], rowCount: 0 });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No rows matched the query');
    });

    it('escapes pipe characters in cell values', () => {
      const blocks = queryDataset.format!({
        rows: [{ name: 'A | B' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('A \\| B');
    });
  });
});
