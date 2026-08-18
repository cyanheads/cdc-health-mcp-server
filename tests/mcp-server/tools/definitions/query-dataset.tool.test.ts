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
  hasMore: false,
};

describe('cdc_query_dataset', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns rows and rowCount for valid input', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext({ errors: queryDataset.errors });
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
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'year=2020' });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('where');
    expect(enrichment.notice).toBeUndefined();
  });

  it('says in the effectiveQuery description that the clauses are replayable as written', () => {
    /**
     * The echo carries each clause in the caller's own text, so it can be pasted back into
     * the parameter it came from. Nothing about the value itself shows that, and a reader
     * who assumes it is URL-encoded will decode it and reintroduce the bug the echo was
     * fixed to avoid.
     */
    const description = queryDataset.enrichment?.effectiveQuery.description ?? '';

    expect(description).toContain('not URL-encoded');
    expect(description).toContain('copied back into the matching parameter');
  });

  it('emits a notice when no rows matched', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$where=x', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1' });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No rows matched');
    expect(enrichment.effectiveQuery).toBe('$where=x');
  });

  it('keeps the no-rows notice unconditional on a paged-past-the-end offset', async () => {
    /**
     * The SODA data endpoint reports no total, so an offset past the end of a real result
     * set and a filter that matched nothing arrive identically. The branch stays one branch.
     */
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$offset=900', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', offset: 900 });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No rows matched');
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.nextOffset).toBeUndefined();
  });

  it('discloses truncation and a usable nextOffset when a further row exists', async () => {
    mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      datasetId: 'bi63-dtpu',
      where: 'year=2020',
      limit: 2,
      offset: 10,
    });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
    expect(enrichment.nextOffset).toBe(12);
    expect(enrichment.notice).toContain('offset=12');
  });

  it('does not disclose truncation when rowCount is below the limit', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'year=2020' });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('does not claim truncation for a complete aggregate that fills its limit', async () => {
    /**
     * `select=count(*)` with `limit: 1` can only ever return one row. Reading `rowCount`
     * back against the limit called that complete answer truncated and sent the caller
     * paginating an aggregate.
     */
    mockQuery.mockResolvedValue({
      rows: [{ total_rows: '67463' }],
      rowCount: 1,
      query: '$select=count(*) as total_rows&$limit=1&$offset=0',
      hasMore: false,
    });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      datasetId: 'akvg-8vrb',
      select: 'count(*) as total_rows',
      limit: 1,
    });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.nextOffset).toBeUndefined();
    expect(enrichment.notice).toBeUndefined();
  });

  it('does not claim truncation when the remaining rows exactly equal the limit', async () => {
    /**
     * The off-by-one the `rowCount === limit` heuristic always got wrong: a result set whose
     * last page happens to fill the limit exactly is complete, not truncated. Only the
     * over-fetch probe can tell the two apart.
     */
    const rows = [{ state: 'CA' }, { state: 'TX' }, { state: 'NY' }];
    mockQuery.mockResolvedValue({ rows, rowCount: 3, query: '$limit=3&$offset=0', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', limit: 3 });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.nextOffset).toBeUndefined();
  });

  it('passes all SoQL clauses to the service', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
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
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu' });
    const result = await queryDataset.handler(input, ctx);
    expect(result.rowCount).toBe(0);
  });

  it('threads an explicit domain through to the service', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$limit=100', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      datasetId: 'swc5-untb',
      domain: 'chronicdata.cdc.gov',
      where: "measureid='OBESITY' AND stateabbr='WA'",
    });
    await queryDataset.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ datasetId: 'swc5-untb', domain: 'chronicdata.cdc.gov' }),
      ctx.signal,
    );
  });

  it('defaults domain to data.cdc.gov', () => {
    expect(queryDataset.input.parse({ datasetId: 'bi63-dtpu' }).domain).toBe('data.cdc.gov');
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
