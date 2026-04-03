/**
 * @fileoverview Tests for cdc_query_dataset tool.
 * @module tests/mcp-server/tools/definitions/query-dataset
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
  query: '$where=year%3D2020&$limit=1000',
};

describe('cdc_query_dataset', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns query results for valid input', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = queryDataset.input.parse({
      datasetId: 'bi63-dtpu',
      where: 'year=2020',
    });
    const result = await queryDataset.handler(input, ctx);

    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    expect(result.query).toContain('where');
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

  it('allows query with no filters (returns all rows)', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=1000' });
    const ctx = createMockContext();
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu' });
    const result = await queryDataset.handler(input, ctx);
    expect(result.rowCount).toBe(0);
  });

  it('rejects invalid dataset ID in schema', () => {
    expect(() => queryDataset.input.parse({ datasetId: 'bad', where: 'x=1' })).toThrow();
  });

  it('applies default limit of 1000', () => {
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1' });
    expect(input.limit).toBe(1000);
  });

  it('rejects limit above 5000', () => {
    expect(() =>
      queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1', limit: 5001 }),
    ).toThrow();
  });

  describe('format', () => {
    it('renders a markdown table', () => {
      const blocks = queryDataset.format!(sampleResult);
      expect(blocks).toHaveLength(1);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('2 rows returned');
      expect(text).toContain('| state | year | deaths |');
      expect(text).toContain('California');
      expect(text).toContain('Texas');
      expect(text).toContain('**Query:**');
    });

    it('renders empty-state message', () => {
      const blocks = queryDataset.format!({ rows: [], rowCount: 0, query: '$where=x' });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No rows matched the query');
      expect(text).toContain('$where=x');
    });

    it('truncates display at 50 rows', () => {
      const manyRows = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
      const blocks = queryDataset.format!({ rows: manyRows, rowCount: 60, query: '' });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('...and 10 more rows');
    });

    it('escapes pipe characters in cell values', () => {
      const result: QueryResult = {
        rows: [{ name: 'A | B' }],
        rowCount: 1,
        query: '',
      };
      const blocks = queryDataset.format!(result);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('A \\| B');
    });
  });
});
