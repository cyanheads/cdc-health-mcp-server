/**
 * @fileoverview Tests for cdc_query_dataset tool.
 * @module tests/mcp-server/tools/definitions/query-dataset
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import type { DatasetMetadata, QueryResult } from '@/services/socrata/types.js';
import { contractError } from '../../../helpers/contract-error.js';
import { expectLinearCostAsync } from '../../../helpers/cpu-cost.js';
import {
  contentText,
  readBack,
  renderedCells,
  renderMarkdown,
  strayElements,
} from '../../../helpers/markdown-render.js';

const mockQuery = vi.fn<() => Promise<QueryResult>>();
const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ query: mockQuery, getMetadata: mockGetMetadata }),
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

  it('keeps the no-match notice at offset > 0 when the same query is empty at offset 0 too', async () => {
    /**
     * The SODA data endpoint reports no total, so an offset past the end of a real result
     * set and a filter that matched nothing arrive identically. One probe at offset 0 — the
     * caller's own clauses, one row — tells them apart; empty there means the filters matched
     * nothing and the no-match guidance stands.
     */
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$offset=900', hasMore: false });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1', offset: 900 });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No rows matched');
    expect(enrichment.notice).not.toMatch(/past the end/i);
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.nextOffset).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: 'x=1', offset: 0, limit: 1 }),
      ctx.signal,
    );
  });

  it('discloses truncation and a usable nextOffset when a further row exists', async () => {
    mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
    const ctx = createMockContext({ errors: queryDataset.errors });
    const input = queryDataset.input.parse({
      datasetId: 'bi63-dtpu',
      where: 'year=2020',
      order: ':id',
      limit: 2,
      offset: 10,
    });
    await queryDataset.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
    expect(enrichment.nextOffset).toBe(12);
    expect(enrichment.notice).toContain('Call again with offset=12 and the same order=":id"');
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

  describe('rows that carry no fields', () => {
    /** What Socrata serves from /resource/{id}.json for a chart or map asset. */
    const fieldlessPage: QueryResult = {
      rows: [{}, {}],
      rowCount: 2,
      query: '$limit=2&$offset=0',
      hasMore: true,
    };

    it('fails not_queryable when the asset metadata reports no columns', async () => {
      /**
       * Socrata answers a chart ID with HTTP 200 and a body of empty objects, so the row
       * shape alone reads as a successful page plus an invitation to keep paging. The
       * asset's column metadata is the signal that separates it from a real result.
       */
      mockQuery.mockResolvedValue(fieldlessPage);
      mockGetMetadata.mockResolvedValue({ name: 'Pfizer Allocations', columns: [] });

      const err = await contractError(queryDataset, { datasetId: 'sxbq-3sid', limit: 2 });

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data.reason).toBe('not_queryable');
      expect(err.data.recovery?.hint).toContain('columnCount');
      expect(err.message).toContain('sxbq-3sid');
      expect(err.message).toContain('Pfizer Allocations');
    });

    it('succeeds with a notice when the dataset has columns but the projection is all null', async () => {
      /**
       * Socrata omits null keys from its JSON, so a real dataset queried with a select that
       * projects only null-valued columns on the matched rows serializes to the same
       * `[{},{}]` shape a chart does. Metadata with columns is what tells them apart.
       */
      mockQuery.mockResolvedValue({ ...fieldlessPage, hasMore: false });
      mockGetMetadata.mockResolvedValue({
        name: 'Provisional COVID-19 Deaths',
        columns: [
          { fieldName: 'footnote', dataType: 'text' },
          { fieldName: 'state', dataType: 'text' },
        ],
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({
        datasetId: '9bhg-hcku',
        select: 'footnote',
        limit: 2,
      });
      const result = await queryDataset.handler(input, ctx);

      expect(result.rowCount).toBe(2);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('select clause "footnote"');
      expect(notice).toContain('null on all 2 matched rows');
      expect(notice).toContain(
        'The dataset itself has 2 columns — check them with cdc_get_dataset_schema',
      );
    });

    it('names every column as the projection when the caller supplied no select', async () => {
      mockQuery.mockResolvedValue({ ...fieldlessPage, hasMore: false });
      mockGetMetadata.mockResolvedValue({
        name: 'Provisional COVID-19 Deaths',
        columns: [{ fieldName: 'state', dataType: 'text' }],
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: '9bhg-hcku', limit: 2 });
      await queryDataset.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('every column of the dataset');
      expect(notice).toContain('null on all 2 matched rows');
      expect(notice).toContain(
        'The dataset itself has 1 column — check it with cdc_get_dataset_schema',
      );
    });

    it('probes with metadata alone, never spending a request on a row count it discards', async () => {
      mockQuery.mockResolvedValue(fieldlessPage);
      mockGetMetadata.mockResolvedValue({ name: 'Chart', columns: [] });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'sxbq-3sid', limit: 2 });
      await Promise.resolve(queryDataset.handler(input, ctx)).catch(() => undefined);

      expect(mockGetMetadata).toHaveBeenCalledWith('sxbq-3sid', ctx.signal, 'data.cdc.gov', {
        liveRowCount: false,
      });
    });

    it('issues no metadata request for a page whose rows carry data', async () => {
      mockQuery.mockResolvedValue(sampleResult);
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'year=2020' });
      await queryDataset.handler(input, ctx);

      expect(mockGetMetadata).not.toHaveBeenCalled();
    });

    it('issues no metadata request when nothing matched', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0, query: '$where=x', hasMore: false });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', where: 'x=1' });
      await queryDataset.handler(input, ctx);

      expect(mockGetMetadata).not.toHaveBeenCalled();
      expect(getEnrichment(ctx).notice).toContain('No rows matched');
    });

    it('issues no metadata request when only some rows carry no fields', async () => {
      /** Socrata rows are sparse per row; one bare row among populated ones is ordinary. */
      mockQuery.mockResolvedValue({
        rows: [{}, { state: 'California' }],
        rowCount: 2,
        query: '$limit=2&$offset=0',
        hasMore: false,
      });
      const ctx = createMockContext({ errors: queryDataset.errors });
      const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', limit: 2 });
      await queryDataset.handler(input, ctx);

      expect(mockGetMetadata).not.toHaveBeenCalled();
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
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

  describe('limit past the 5,000-row cap', () => {
    const notice = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      (result.structuredContent as { notice?: string }).notice;

    /** The service was asked for the 5,000-row cap, whatever limit the caller sent. */
    const expectCappedRequest = () =>
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5000 }),
        expect.anything(),
      );

    it.each([5001, 1_000_000])(
      'clamps limit %i to 5,000 and names the cap when rows remain',
      async (limit) => {
        mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
        const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit });

        expectCappedRequest();
        expect(result.structuredContent).toMatchObject({
          truncated: true,
          shown: 2,
          cap: 5000,
          nextOffset: 2,
        });
        expect(notice(result)).toBe(
          `More rows exist beyond this response — limit=${limit} is above the 5,000 rows one call returns, so the page stopped at 5,000. To page on without skipping or repeating rows, call again from offset=0 with order=":id" and continue by offset from there. ":id" is the row identifier every dataset carries, and this page was read without that tie-breaker, so the rows returned so far need not be the ones that order puts first.`,
        );
        expect(contentText(result)).toContain(
          `limit=${limit} is above the 5,000 rows one call returns`,
        );
      },
    );

    it('clamps a limit the framework repaired from a string ("6000")', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
      // A string where the schema takes a number: the framework's argument repair reads it as 6000.
      const args = { datasetId: 'bi63-dtpu', limit: '6000' } as unknown as { datasetId: string };
      const result = await runToolContract(queryDataset, args);

      expect(result.isError).toBeFalsy();
      expectCappedRequest();
      expect(notice(result)).toContain('limit=6000 is above the 5,000 rows one call returns');
    });

    it('says nothing of the cap when a clamped limit returned the whole remainder', async () => {
      mockQuery.mockResolvedValue(sampleResult);
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 5001 });

      expectCappedRequest();
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect(notice(result)).toBeUndefined();
    });

    it('names the cap beside a budget cut of a clamped page, every count formatted alike', async () => {
      // Rows narrow enough that the budget keeps over a thousand of them, wide enough to cut.
      const wide = Array.from({ length: 5000 }, (_, i) => ({ blob: `${i}-${'w'.repeat(60)}` }));
      mockQuery.mockResolvedValue({
        rows: wide,
        rowCount: 5000,
        query: '$limit=5000&$offset=0',
        hasMore: true,
      });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 7000 });
      const sc = result.structuredContent as { shown: number; cap: number; notice: string };

      expect(sc.cap).toBe(5000);
      expect(sc.shown).toBeGreaterThan(999);
      expect(sc.shown).toBeLessThan(5000);
      expect(sc.notice).toContain(
        `cut the page at ${sc.shown.toLocaleString('en-US')} of the 5,000 rows requested (limit=7000 is capped at 5,000 rows per call).`,
      );
    });

    it('formats the fieldless-row count beside the formatted cap', async () => {
      mockQuery.mockResolvedValue({
        rows: Array.from({ length: 5000 }, () => ({})),
        rowCount: 5000,
        query: '$select=footnote&$limit=5000&$offset=0',
        hasMore: true,
      });
      mockGetMetadata.mockResolvedValue({
        name: 'Real',
        columns: [{ fieldName: 'footnote', dataType: 'text' }],
      });
      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        select: 'footnote',
        limit: 7000,
      });

      expect((result.structuredContent as { notice: string }).notice).toContain(
        'the select clause "footnote" is null on all 5,000 matched rows',
      );
    });

    it('keeps a limit at or below the cap exactly as today, with no cap notice', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 5000 });

      expectCappedRequest();
      expect(notice(result)).toBe(
        'More rows exist beyond this response — the requested limit of 5000 was reached. To page on without skipping or repeating rows, call again from offset=0 with order=":id" and continue by offset from there. ":id" is the row identifier every dataset carries, and this page was read without that tie-breaker, so the rows returned so far need not be the ones that order puts first.',
      );
    });

    it('still rejects a non-integer limit', () => {
      /** 0 and 1,000,001 are pinned with the other input bounds in the security suite. */
      expect(() => queryDataset.input.parse({ datasetId: 'bi63-dtpu', limit: 2.5 })).toThrow();
    });
  });

  describe('continuation order advice', () => {
    /** The truncated-page notice for `input`, from a page of two rows at offset 3 with more behind it. */
    const adviceFor = async (input: Record<string, unknown>) => {
      mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        limit: 2,
        offset: 3,
        ...input,
      });
      return (result.structuredContent as { notice: string }).notice.replace(
        'More rows exist beyond this response — the requested limit of 2 was reached. ',
        '',
      );
    };

    const GROUPED = 'The grouped columns identify each row of a grouped result';
    const DISTINCT = 'The selected columns identify each row of a distinct select';
    const RAW = '":id" is the row identifier every dataset carries';
    /** The advice when the tie-breaker has to be added: restart the walk under the new order. */
    const restart = (order: string, reason: string) =>
      `To page on without skipping or repeating rows, call again from offset=0 with order="${order}" and continue by offset from there. ${reason}, and this page was read without that tie-breaker, so the rows returned so far need not be the ones that order puts first.`;

    it('keeps a grouped query’s order and appends the grouped column, never :id', async () => {
      const advice = await adviceFor({
        select: 'state,sum(deaths) as total',
        where: 'year=2017',
        group: 'state',
        having: 'sum(deaths)>100000',
        order: 'total DESC',
      });

      expect(advice).toBe(restart('total DESC, state', GROUPED));
    });

    it('orders an unordered grouped query by its grouped columns', async () => {
      expect(await adviceFor({ select: 'state, count(*) as n', group: 'state' })).toBe(
        restart('state', GROUPED),
      );
    });

    it('appends every column of a multi-column group, split at top-level commas only', async () => {
      expect(
        await adviceFor({
          group: "state,year, case(x='a,b', 'y', true, 'z')",
          order: 'total DESC',
        }),
      ).toBe(restart("total DESC, state, year, case(x='a,b', 'y', true, 'z')", GROUPED));
    });

    it('orders a distinct select by its selected columns, never :id', async () => {
      expect(await adviceFor({ select: 'distinct cause_name' })).toBe(
        restart('cause_name', DISTINCT),
      );
    });

    it('names a distinct column by its alias and skips one the order already carries', async () => {
      expect(
        await adviceFor({ select: ' DISTINCT cause_name AS c, state', order: 'state DESC' }),
      ).toBe(restart('state DESC, c', DISTINCT));
    });

    it('orders raw rows with no order by :id', async () => {
      expect(await adviceFor({})).toBe(restart(':id', RAW));
    });

    it('appends :id to the order of raw rows', async () => {
      expect(await adviceFor({ order: 'year DESC' })).toBe(restart('year DESC, :id', RAW));
    });

    it('continues at nextOffset under an order that already carries its tie-breaker', async () => {
      expect(await adviceFor({ group: 'state', order: 'total DESC,  STATE asc nulls last' })).toBe(
        'Call again with offset=5 and the same order="total DESC,  STATE asc nulls last" to continue.',
      );
      expect(await adviceFor({ order: 'year, :id DESC' })).toBe(
        'Call again with offset=5 and the same order="year, :id DESC" to continue.',
      );
    });

    it('never rewrites the order sent upstream, nor truncated or nextOffset', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        group: 'state',
        order: 'total DESC',
        limit: 2,
        offset: 3,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'state', order: 'total DESC' }),
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({ truncated: true, nextOffset: 5 });
    });

    /**
     * A fake Socrata over grouped rows whose counts tie: under a tied order the ties come back
     * in storage order, which is not the order the tie-breaker puts them in — so a page read
     * under `n DESC` is not a prefix of the walk under `n DESC, state`. Rows are sorted by each
     * ORDER BY term in turn (stable over storage order), then sliced by offset and limit.
     */
    const stored = [
      { state: 'Texas', n: '9' },
      { state: 'Oregon', n: '9' },
      { state: 'Idaho', n: '9' },
      { state: 'Alabama', n: '9' },
      { state: 'Colorado', n: '9' },
      { state: 'Arizona', n: '9' },
      { state: 'Utah', n: '5' },
      { state: 'Maine', n: '5' },
      { state: 'Iowa', n: '5' },
    ];
    const fakeSocrata = (options: { order?: string; limit: number; offset: number }) => {
      const terms = (options.order ?? '').split(',').map((term) => {
        const [field = '', direction] = term.trim().split(/\s+/);
        return {
          field: field as keyof (typeof stored)[number],
          desc: /^desc$/i.test(direction ?? ''),
        };
      });
      const sorted = [...stored].sort((a, b) => {
        for (const { field, desc } of terms) {
          if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (desc ? -1 : 1);
        }
        return 0;
      });
      const rows = sorted.slice(options.offset, options.offset + options.limit);
      return Promise.resolve({
        rows,
        rowCount: rows.length,
        query: `$order=${options.order}&$limit=${options.limit}&$offset=${options.offset}`,
        hasMore: options.offset + rows.length < stored.length,
      });
    };

    /**
     * Walk the result exactly as each notice instructs — its offset, its order, and a fresh
     * start whenever it sends the walk back to offset 0 — and return the rows the walk holds.
     */
    const walkAsAdvised = async (order: string, limit: number) => {
      mockQuery.mockImplementation(fakeSocrata as unknown as () => Promise<QueryResult>);
      let request = { order, offset: 0 };
      let walked: string[] = [];
      for (let call = 0; call < 20; call++) {
        const result = await runToolContract(queryDataset, {
          datasetId: 'bi63-dtpu',
          select: 'state, count(*) as n',
          group: 'state',
          limit,
          ...request,
        });
        const sc = result.structuredContent as { rows: { state: string }[]; notice?: string };
        if (request.offset === 0) walked = [];
        walked.push(...sc.rows.map((row) => row.state));
        if (!sc.notice) return walked;
        request = {
          offset: Number(/offset=(\d+)/.exec(sc.notice)?.[1]),
          order: /order="([^"]*)"/.exec(sc.notice)?.[1] ?? request.order,
        };
      }
      throw new Error('walk did not end');
    };

    it.each([2, 4])(
      'walks a tied order to the rows of the tie-broken order, none skipped or repeated (limit %i)',
      async (limit) => {
        const reference = await fakeSocrata({ order: 'n DESC, state', limit: 99, offset: 0 });

        expect(reference.rows.map((row) => row.state)).toEqual([
          'Alabama',
          'Arizona',
          'Colorado',
          'Idaho',
          'Oregon',
          'Texas',
          'Iowa',
          'Maine',
          'Utah',
        ]);
        expect(await walkAsAdvised('n DESC', limit)).toEqual(
          reference.rows.map((row) => row.state),
        );
      },
    );

    it('builds the advice in time linear in the length of the clauses', async () => {
      /** Clause length is the caller's, so the split must scale with it. */
      mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
      await expectLinearCostAsync(
        (n) => `${'(('.repeat(n / 8)}${",'`".repeat(n / 8)}`,
        async (clause) =>
          queryDataset.handler(
            queryDataset.input.parse({
              datasetId: 'bi63-dtpu',
              select: `distinct ${clause}`,
              order: clause,
              limit: 2,
            }),
            createMockContext({ errors: queryDataset.errors }),
          ),
      );
    });
  });

  describe('whitespace-only clauses', () => {
    it('quotes no blank select in the fieldless-rows notice', async () => {
      mockQuery.mockResolvedValue({
        rows: [{}],
        rowCount: 1,
        query: '$limit=1&$offset=0',
        hasMore: false,
      });
      mockGetMetadata.mockResolvedValue({
        name: 'Real',
        columns: [{ fieldName: 'state', dataType: 'text' }],
      });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', select: ' ' });

      expect((result.structuredContent as { notice: string }).notice).toContain(
        'every column of the dataset is null on the 1 matched row,',
      );
    });

    it('gives the order advice of an unordered, ungrouped query when order and group are blank', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, hasMore: true });
      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        group: '  ',
        order: ' ',
        select: ' ',
        limit: 2,
      });

      expect((result.structuredContent as { notice: string }).notice).toContain(
        'call again from offset=0 with order=":id" and continue',
      );
    });
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

    it('renders an empty page without asserting a cause the notice may contradict', () => {
      /**
       * An empty page is a no-match, an offset past the end, or undiagnosed — only the
       * handler's notice knows which, and it reaches content[] through the trailer.
       */
      const blocks = queryDataset.format!({ rows: [], rowCount: 0 });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('0 rows returned');
      expect(text).not.toMatch(/No rows matched|spelled|filters/i);
    });

    it('renders a null-only projection as a line of text rather than an empty table', () => {
      /**
       * Socrata omits null keys, so a projection null on every matched row arrives as rows
       * carrying no fields. Rendered as a table that is a header of nothing over rows of
       * nothing — the degenerate output a client reading only content[] is left with.
       */
      const blocks = queryDataset.format!({ rows: [{}, {}, {}], rowCount: 3 });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).not.toContain('|');
      expect(text).toContain('3 rows');
      expect(text).toContain('no fields');
    });

    it('still renders a table when only some rows carry no fields', () => {
      /** A bare row among populated ones is ordinary Socrata sparsity, not a null projection. */
      const blocks = queryDataset.format!({ rows: [{}, { state: 'California' }], rowCount: 2 });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('2 rows returned');
      expect(text).toContain('| state |');
      expect(text).toContain('California');
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

  describe('content[] Markdown rendering', () => {
    const REPRO_VALUE = '<b>literal</b> *emphasis* [label](https://example.com)';
    const AGGREGATE_QUERY =
      '$select=state, count(*) as n&$where=year=2017&$group=state&$having=count(*) > 5&$order=state&$limit=2';

    it('renders a cell value as the literal text structuredContent carries', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ sample: REPRO_VALUE }],
        rowCount: 1,
        query: `$select='${REPRO_VALUE}' as sample&$limit=1`,
        hasMore: false,
      });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 1 });

      expect((result.structuredContent as { rows: unknown[] }).rows).toEqual([
        { sample: REPRO_VALUE },
      ]);
      const text = contentText(result);
      expect(text).toContain(
        '| \\<b>literal\\</b> \\*emphasis\\* \\[label\\](https://example.com) |',
      );
      const cells = renderedCells(renderMarkdown(text));
      expect(cells.map(readBack)).toEqual([REPRO_VALUE]);
      expect(strayElements(cells[0] ?? '', [])).toEqual([]);
    });

    it('renders a header the caller aliased into emphasis syntax as its literal name', async () => {
      /** SoQL accepts `_x_` as an alias, and left bare it renders as an emphasized `x`. */
      mockQuery.mockResolvedValue({
        rows: [{ _x_: 'United States' }],
        rowCount: 1,
        query: '$select=state as _x_&$limit=1',
        hasMore: false,
      });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 1 });

      const header = renderMarkdown(contentText(result)).match(/<th>([\s\S]*?)<\/th>/)?.[1] ?? '';
      expect(header).toBe('_x_');
    });

    it('renders effectiveQuery as a code span that reads back byte-identical', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ state: 'Alabama', n: '12' }],
        rowCount: 1,
        query: AGGREGATE_QUERY,
        hasMore: false,
      });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 2 });

      expect((result.structuredContent as { effectiveQuery: string }).effectiveQuery).toBe(
        AGGREGATE_QUERY,
      );
      const text = contentText(result);
      expect(text).toContain(`**effectiveQuery:** \`${AGGREGATE_QUERY}\``);
      const html = renderMarkdown(text);
      expect(html).not.toContain('<em>');
      const codes = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) =>
        readBack(m[1] ?? ''),
      );
      expect(codes).toContain(AGGREGATE_QUERY);
    });

    it('renders a notice quoting the caller as one escaped blockquote', async () => {
      const select = '<i>qqw</i> *qqv*\n\n# injected';
      mockQuery.mockResolvedValue({ rows: [{}], rowCount: 1, query: '$limit=1', hasMore: false });
      mockGetMetadata.mockResolvedValue({
        name: 'Real',
        columns: [{ fieldName: 'state', dataType: 'text' }],
      });
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', select });

      expect((result.structuredContent as { notice: string }).notice).toContain(
        `the select clause "${select}"`,
      );
      const html = renderMarkdown(contentText(result));
      const quote = html.match(/<blockquote>([\s\S]*?)<\/blockquote>/)?.[1] ?? '';
      expect(strayElements(quote, ['p'])).toEqual([]);
      expect(readBack(quote).replace(/\s+/g, ' ')).toContain(
        'the select clause "<i>qqw</i> *qqv* # injected"',
      );
      expect(html).not.toContain('<h1>');
    });
  });
});
