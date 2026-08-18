/**
 * @fileoverview Tests for cdc_query_wonder tool.
 * @module tests/mcp-server/tools/definitions/query-wonder
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import type { WonderResult } from '@/services/wonder/types.js';

const mockQuery = vi.fn<() => Promise<WonderResult>>();

vi.mock('@/services/wonder/wonder-service.js', () => ({
  getWonderService: () => ({ query: mockQuery }),
}));

const sampleResult: WonderResult = {
  rows: [
    {
      year: '2019',
      sex: 'Female',
      deaths: 283725,
      population: 166582199,
      crude_rate: 170.3,
      age_adjusted_rate: 126.2,
    },
    {
      year: '2019',
      sex: 'Male',
      deaths: 315876,
      population: 161657324,
      crude_rate: 195.4,
      age_adjusted_rate: 172.9,
    },
  ],
  rowCount: 2,
  database: 'D76',
  databaseTitle: 'Underlying Cause of Death, 1999-2020',
  caveats: ['A caveat.'],
  cellNotes: [],
  messages: [],
  suppressedCount: 0,
  columns: ['year', 'sex', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
};

/** The two messages D76 returns when it drops rows from a table before sending it. */
const HIDDEN_ROW_MESSAGES = [
  'Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.',
  'Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.',
];

/** One row whose crude rate CDC flagged Unreliable — published, not withheld. */
const unreliableResult: WonderResult = {
  ...sampleResult,
  rows: [
    {
      age_group: '15-24 years',
      deaths: 10,
      population: 42687510,
      crude_rate: null,
    },
  ],
  rowCount: 1,
  cellNotes: [{ row: 0, column: 'crude_rate', token: 'Unreliable' }],
  columns: ['age_group', 'deaths', 'population', 'crude_rate'],
};

describe('cdc_query_wonder', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns rows, database, caveats and suppressedCount', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext({ errors: queryWonder.errors });
    const input = queryWonder.input.parse({ group_by: ['year', 'sex'], cause_icd10: 'C00-C97' });
    const result = await queryWonder.handler(input, ctx);

    expect(result.rowCount).toBe(2);
    expect(result.database).toBe('D76');
    expect(result.databaseTitle).toBe('Underlying Cause of Death, 1999-2020');
    expect(result.caveats).toEqual(['A caveat.']);
    expect(result.suppressedCount).toBe(0);
    // internal ordering column list is not part of the tool output
    expect((result as Record<string, unknown>).columns).toBeUndefined();
  });

  it('maps friendly inputs to service options (empty cause coerced away)', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext({ errors: queryWonder.errors });
    const input = queryWonder.input.parse({
      group_by: ['year'],
      cause_icd10: '',
      sex: 'male',
      age_groups: ['25-34'],
      year_range: { from: 2018, to: 2020 },
    });
    await queryWonder.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      {
        database: 'underlying_1999_2020',
        groupBy: ['year'],
        sex: 'male',
        ageGroups: ['25-34'],
        yearRange: { from: 2018, to: 2020 },
      },
      ctx.signal,
    );
  });

  it('passes the selected database and multiple-cause filter through to the service', async () => {
    mockQuery.mockResolvedValue({ ...sampleResult, database: 'D77' });
    const ctx = createMockContext({ errors: queryWonder.errors });
    const input = queryWonder.input.parse({
      database: 'multiple_1999_2020',
      group_by: ['year'],
      mcd_icd10: 'J00-J98',
    });
    await queryWonder.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({ database: 'multiple_1999_2020', mcdIcd10: 'J00-J98' }),
      ctx.signal,
    );
  });

  it('enriches with a human-readable query summary', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext({ errors: queryWonder.errors });
    const input = queryWonder.input.parse({ group_by: ['year', 'sex'], cause_icd10: 'C00-C97' });
    await queryWonder.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('grouped by year, sex');
    expect(enrichment.effectiveQuery).toContain('cause C00-C97');
    expect(enrichment.notice).toBeUndefined();
  });

  it('notices when no rows matched', async () => {
    mockQuery.mockResolvedValue({ ...sampleResult, rows: [], rowCount: 0 });
    const ctx = createMockContext({ errors: queryWonder.errors });
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    expect(getEnrichment(ctx).notice).toContain('No rows matched');
  });

  it('returns the hidden-row messages and warns that the row set is filtered', async () => {
    /**
     * A row CDC hid never reaches `rows`, and nothing in the table marks the gap — without
     * this the caller cannot tell a stratum with no deaths from one that was dropped.
     */
    mockQuery.mockResolvedValue({ ...sampleResult, messages: HIDDEN_ROW_MESSAGES });
    const ctx = createMockContext({ errors: queryWonder.errors });
    const result = await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);

    expect(result.messages).toEqual(HIDDEN_ROW_MESSAGES);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('CDC withheld whole rows');
    expect(notice).toContain('Rows with zero Deaths are hidden.');
    expect(notice).toContain('Rows with suppressed Deaths are hidden.');
    expect(notice).toContain('partial');
  });

  it('leaves the notice alone when the messages are not about withheld rows', async () => {
    mockQuery.mockResolvedValue({
      ...sampleResult,
      messages: ['Totals are not available for these results due to suppression constraints.'],
    });
    const ctx = createMockContext({ errors: queryWonder.errors });
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('does not read an empty result as "nothing matched" when rows were withheld', async () => {
    /** Every matching stratum can be hidden, which reads as zero rows and means the opposite. */
    mockQuery.mockResolvedValue({
      ...sampleResult,
      rows: [],
      rowCount: 0,
      messages: HIDDEN_ROW_MESSAGES,
    });
    const ctx = createMockContext({ errors: queryWonder.errors });
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('not evidence that nothing matched');
    expect(notice).not.toContain('No rows matched');
  });

  it('notices when cells were suppressed', async () => {
    mockQuery.mockResolvedValue({
      ...sampleResult,
      cellNotes: [
        { row: 0, column: 'deaths', token: 'Suppressed' },
        { row: 1, column: 'deaths', token: 'Suppressed' },
        { row: 1, column: 'crude_rate', token: 'Suppressed' },
      ],
      suppressedCount: 3,
    });
    const ctx = createMockContext({ errors: queryWonder.errors });
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('3 cell(s) were withheld');
    // Suppression is withholding — it must never be tallied into the "not withheld" phrasing.
    expect(notice).not.toContain('not withheld');
    expect(notice).not.toContain('Suppressed (3 cells)');
  });

  it('returns cellNotes and notices unreliable cells as published, not withheld', async () => {
    mockQuery.mockResolvedValue(unreliableResult);
    const ctx = createMockContext({ errors: queryWonder.errors });
    const result = await queryWonder.handler(
      queryWonder.input.parse({ group_by: ['age_group'], cause_icd10: 'E11' }),
      ctx,
    );

    expect(result.cellNotes).toEqual([{ row: 0, column: 'crude_rate', token: 'Unreliable' }]);
    expect(result.suppressedCount).toBe(0);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('Unreliable (1 cell)');
    expect(notice).toContain('fewer than 20 deaths');
    expect(notice).toContain('not withheld');
    expect(notice).not.toContain('withheld by CDC for confidentiality');
  });

  it('forwards a service McpError through ctx.fail with its declared reason', async () => {
    mockQuery.mockRejectedValue(
      validationError('CDC WONDER rejected the request: bad code', { reason: 'invalid_query' }),
    );
    // ctx.fail / ctx.recoveryFor are injected by the tool wrapper from the errors[] contract;
    // stub them to unit-test the handler's reason-extraction-and-forwarding logic.
    const ctx = Object.assign(createMockContext({ errors: queryWonder.errors }), {
      recoveryFor: (reason: string) => ({ recovery: `recover ${reason}` }),
      fail: (reason: string, message?: string, data?: Record<string, unknown>) =>
        new McpError(JsonRpcErrorCode.ValidationError, message ?? '', { reason, ...data }),
    });
    await expect(
      queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
  });

  describe('database-conditional rejections', () => {
    /**
     * Every check runs in the handler rather than a Zod refinement. A refinement contributes
     * nothing to the emitted JSON Schema and fails as a raw ZodError at the transport, before
     * the handler and its declared recovery hint are reached — the defect #27 corrected for
     * cdc_discover_datasets. These cases pin the handler-level behaviour: a declared reason,
     * the contract recovery attached, and a message that names the way out.
     */
    function failingContext() {
      return Object.assign(createMockContext({ errors: queryWonder.errors }), {
        recoveryFor: (reason: string) => ({ recovery: `recover ${reason}` }),
        fail: (reason: string, message?: string, data?: Record<string, unknown>) =>
          new McpError(JsonRpcErrorCode.ValidationError, message ?? '', { reason, ...data }),
      });
    }

    it('rejects a year range outside the selected database, naming that database’s span', async () => {
      const ctx = failingContext();
      const input = queryWonder.input.parse({
        group_by: ['year'],
        year_range: { from: 2021, to: 2024 },
      });
      const err = (await Promise.resolve(queryWonder.handler(input, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({
        reason: 'invalid_query',
        recovery: 'recover invalid_query',
      });
      expect(err.message).toContain('1999–2020');
      expect(err.message).toContain('2021–2024');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('accepts a year range the selected database does hold but the default does not', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, database: 'D176' });
      const ctx = failingContext();
      const input = queryWonder.input.parse({
        database: 'provisional',
        group_by: ['year'],
        year_range: { from: 2021, to: 2024 },
      });
      await queryWonder.handler(input, ctx);
      expect(mockQuery).toHaveBeenCalled();
    });

    it.each(['underlying_1999_2020', 'underlying_2018_2024'] as const)(
      'rejects mcd_icd10 against %s and names the databases that accept it',
      async (database) => {
        const ctx = failingContext();
        const input = queryWonder.input.parse({
          database,
          group_by: ['year'],
          mcd_icd10: 'J00-J98',
        });
        const err = (await Promise.resolve(queryWonder.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err).toBeInstanceOf(McpError);
        expect(err.data).toMatchObject({
          reason: 'invalid_query',
          recovery: 'recover invalid_query',
        });
        expect(err.message).toContain('multiple_1999_2020');
        expect(err.message).toContain('provisional');
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it.each(['multiple_1999_2020', 'multiple_2018_2024', 'provisional'] as const)(
      'accepts mcd_icd10 against %s',
      async (database) => {
        mockQuery.mockResolvedValue(sampleResult);
        const ctx = failingContext();
        const input = queryWonder.input.parse({
          database,
          group_by: ['year'],
          mcd_icd10: 'J00-J98',
        });
        await queryWonder.handler(input, ctx);
        expect(mockQuery).toHaveBeenCalled();
      },
    );

    it.each([
      ['underlying_1999_2020', 'cause_icd10'],
      ['underlying_2018_2024', 'cause_icd10'],
      ['multiple_1999_2020', 'mcd_icd10'],
      ['multiple_2018_2024', 'mcd_icd10'],
    ] as const)(
      'rejects the withheld-cause marker on %s (%s) and names the database that holds it',
      async (database, field) => {
        /**
         * WONDER's own rejection calls `999--999` an invalid ICD-10 code and points at the
         * finder tool, which reads as "no such code" when the code is real on another database.
         */
        const ctx = failingContext();
        const input = queryWonder.input.parse({
          database,
          group_by: ['year'],
          [field]: '999--999',
        });
        const err = (await Promise.resolve(queryWonder.handler(input, ctx)).catch(
          (e: unknown) => e,
        )) as McpError;

        expect(err).toBeInstanceOf(McpError);
        expect(err.data).toMatchObject({
          reason: 'invalid_query',
          recovery: 'recover invalid_query',
        });
        // The enum value, not just the word — the message has to be actionable as an input.
        expect(err.message).toContain('database "provisional"');
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it.each(['cause_icd10', 'mcd_icd10'] as const)(
      'accepts the withheld-cause marker as %s on the provisional database',
      async (field) => {
        mockQuery.mockResolvedValue({ ...sampleResult, database: 'D176' });
        const ctx = failingContext();
        const input = queryWonder.input.parse({
          database: 'provisional',
          group_by: ['year'],
          [field]: '999--999',
        });
        await queryWonder.handler(input, ctx);
        expect(mockQuery).toHaveBeenCalledWith(
          expect.objectContaining(
            field === 'cause_icd10' ? { causeIcd10: '999--999' } : { mcdIcd10: '999--999' },
          ),
          ctx.signal,
        );
      },
    );

    it('warns that an unfiltered multiple-cause database repeats its underlying-cause twin', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, database: 'D77' });
      const ctx = createMockContext({ errors: queryWonder.errors });
      await queryWonder.handler(
        queryWonder.input.parse({ database: 'multiple_1999_2020', group_by: ['year'] }),
        ctx,
      );
      const notice = getEnrichment(ctx).notice ?? '';
      expect(notice).toContain('D76');
      expect(notice).toContain('mcd_icd10');
    });

    it('drops the twin notice once mcd_icd10 gives the database something its twin cannot do', async () => {
      /**
       * The notice says the selected database is repeating its twin's figures. With a
       * multiple-cause filter that is false — the counts diverge — and pointing the caller at
       * the underlying-cause database would send them to a query that cannot express the
       * question they asked.
       */
      mockQuery.mockResolvedValue({ ...sampleResult, database: 'D77' });
      const ctx = createMockContext({ errors: queryWonder.errors });
      await queryWonder.handler(
        queryWonder.input.parse({
          database: 'multiple_1999_2020',
          group_by: ['year'],
          mcd_icd10: 'J00-J98',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('stays quiet about a twin on the provisional database, which has none', async () => {
      /** Provisional runs past where the final databases stop, so selecting it is never a no-op. */
      mockQuery.mockResolvedValue({ ...sampleResult, database: 'D176' });
      const ctx = createMockContext({ errors: queryWonder.errors });
      await queryWonder.handler(
        queryWonder.input.parse({ database: 'provisional', group_by: ['year'] }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('row pagination', () => {
    /**
     * Six rows of a year × sex breakdown with two flagged cells at known indices — an
     * Unreliable rate on row 1 and a Suppressed death count on row 4. The distance between
     * them is what a page has to survive: `format()` looks a token up by render index, so a
     * page sliced without re-basing `cellNotes` paints the row-1 token onto whichever row
     * happens to sit at index 1 of that page.
     */
    const pagedResult: WonderResult = {
      ...sampleResult,
      rows: [
        { year: '2019', sex: 'Female', deaths: 100, population: 1000, crude_rate: 10 },
        { year: '2019', sex: 'Male', deaths: 110, population: 1000, crude_rate: null },
        { year: '2020', sex: 'Female', deaths: 120, population: 1000, crude_rate: 12 },
        { year: '2020', sex: 'Male', deaths: 130, population: 1000, crude_rate: 13 },
        { year: '2021', sex: 'Female', deaths: null, population: 1000, crude_rate: null },
        { year: '2021', sex: 'Male', deaths: 160, population: 1000, crude_rate: 16 },
      ],
      rowCount: 6,
      caveats: ['Population figures are bridged-race estimates.'],
      cellNotes: [
        { row: 1, column: 'crude_rate', token: 'Unreliable' },
        { row: 4, column: 'deaths', token: 'Suppressed' },
      ],
      messages: HIDDEN_ROW_MESSAGES,
      suppressedCount: 1,
      columns: ['year', 'sex', 'deaths', 'population', 'crude_rate'],
    };

    /** Run the tool over `pagedResult` with the given page inputs. */
    async function page(fields: Record<string, unknown>) {
      mockQuery.mockResolvedValue(pagedResult);
      const ctx = createMockContext({ errors: queryWonder.errors });
      const result = await queryWonder.handler(
        queryWonder.input.parse({ group_by: ['year', 'sex'], ...fields }),
        ctx,
      );
      return { result, enrichment: getEnrichment(ctx) };
    }

    it('returns the whole table untouched when limit and offset are omitted', async () => {
      const { result, enrichment } = await page({});

      expect(result.rows).toEqual(pagedResult.rows);
      expect(result.rowCount).toBe(6);
      expect(result.cellNotes).toEqual(pagedResult.cellNotes);
      expect(result.suppressedCount).toBe(1);
      expect(result.caveats).toEqual(pagedResult.caveats);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.shown).toBeUndefined();
      expect(enrichment.cap).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
    });

    it('reports the table total whether or not a page was taken', async () => {
      expect((await page({})).enrichment.totalCount).toBe(6);
      expect((await page({ limit: 2 })).enrichment.totalCount).toBe(6);
      expect((await page({ offset: 4 })).enrichment.totalCount).toBe(6);
    });

    it('bounds the table at limit and points at the next page', async () => {
      const { result, enrichment } = await page({ limit: 3 });

      expect(result.rows).toEqual(pagedResult.rows.slice(0, 3));
      expect(result.rowCount).toBe(3);
      expect(enrichment.totalCount).toBe(6);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(3);
      expect(enrichment.cap).toBe(3);
      expect(enrichment.nextOffset).toBe(3);
      expect(enrichment.notice).toContain('rows 1–3 of 6');
      expect(enrichment.notice).toContain('offset=3');
    });

    it('continues from an explicit offset', async () => {
      const { result, enrichment } = await page({ limit: 2, offset: 2 });

      expect(result.rows).toEqual(pagedResult.rows.slice(2, 4));
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBe(4);
    });

    it('re-indexes cellNotes to the returned page and recounts suppression from it', async () => {
      /**
       * The parser numbers a cell note against the whole parsed table. A page that carries
       * the table's numbering describes cells it does not contain, and `suppressedCount`
       * then counts withholding that happened somewhere else.
       */
      const { result } = await page({ limit: 3, offset: 3 });

      expect(result.rows).toEqual(pagedResult.rows.slice(3, 6));
      expect(result.cellNotes).toEqual([{ row: 1, column: 'deaths', token: 'Suppressed' }]);
      expect(result.suppressedCount).toBe(1);
    });

    it('leaves a later page carrying only its own notes, with none from an earlier one', async () => {
      const { result } = await page({ limit: 3, offset: 3 });
      expect(result.cellNotes.every((n) => n.token === 'Suppressed')).toBe(true);
      expect(result.cellNotes.map((n) => n.row)).toEqual([1]);
    });

    it('paints each status token on the row it belongs to on a later page', async () => {
      /**
       * The mis-painting this guards: `format()` keys `cellNotes` by render index, so a page
       * whose notes still carry table indices moves the row-1 `Unreliable` marker onto the
       * row sitting at index 1 of the page — a withheld figure and a published-but-unstable
       * one swapped onto healthy rows, with nothing in the output saying so.
       */
      const { result } = await page({ limit: 3, offset: 3 });
      const text = (queryWonder.format!(result)[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('| 2020 | Male | 130 | 1000 | 13 |');
      expect(text).toContain('| 2021 | Female | Suppressed | 1000 |  |');
      expect(text).toContain('| 2021 | Male | 160 | 1000 | 16 |');
      expect(text).not.toContain('Unreliable');
      expect(text).toContain('1 cell(s) withheld by CDC for confidentiality');
    });

    it('renders exactly the page in content[] that structuredContent carries', async () => {
      const { result } = await page({ limit: 2, offset: 1 });
      const text = (queryWonder.format!(result)[0] as { type: 'text'; text: string }).text;
      const dataRows = text.split('\n').filter((l) => /^\| 20\d\d \|/.test(l));

      expect(text).toContain('— 2 rows');
      expect(dataRows).toHaveLength(result.rows.length);
      expect(dataRows[0]).toBe('| 2019 | Male | 110 | 1000 | Unreliable |');
      expect(dataRows[1]).toBe('| 2020 | Female | 120 | 1000 | 12 |');
    });

    it('returns an empty page rather than an error when offset is past the end', async () => {
      const { result, enrichment } = await page({ offset: 20 });

      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(0);
      expect(result.cellNotes).toEqual([]);
      expect(result.suppressedCount).toBe(0);
      expect(enrichment.totalCount).toBe(6);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toContain('past the end');
      // The query matched — an empty page is not an empty result set.
      expect(enrichment.notice).not.toContain('No rows matched');
    });

    it('returns only the remaining rows when offset plus limit runs past the end', async () => {
      const { result, enrichment } = await page({ limit: 5, offset: 4 });

      expect(result.rows).toEqual(pagedResult.rows.slice(4));
      expect(result.rowCount).toBe(2);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toContain('the end of the table');
    });

    it('returns every row when limit exceeds the table', async () => {
      const { result, enrichment } = await page({ limit: 500 });

      expect(result.rows).toEqual(pagedResult.rows);
      expect(enrichment.totalCount).toBe(6);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
    });

    it('takes the whole remainder when offset is set and limit is omitted', async () => {
      const { result, enrichment } = await page({ offset: 2 });

      expect(result.rows).toEqual(pagedResult.rows.slice(2));
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
    });

    it('reaches every row across a sequence of pages, without gaps or repeats', async () => {
      const seen: unknown[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const { result, enrichment } = await page({ limit: 2, offset });
        seen.push(...result.rows);
        offset = enrichment.nextOffset as number | undefined;
        pages += 1;
      }
      expect(pages).toBe(3);
      expect(seen).toEqual(pagedResult.rows);
    });

    it('keeps caveats and messages whole and identical on every page', async () => {
      /**
       * Both describe the table CDC assembled, not the slice handed back. Scoping them to a
       * page would let a caveat or a hidden-row notice disappear from the page a reader
       * happens to stop on — the disclosure the whole-table notices exist to prevent.
       */
      const first = await page({ limit: 3 });
      const second = await page({ limit: 3, offset: 3 });

      expect(first.result.caveats).toEqual(pagedResult.caveats);
      expect(second.result.caveats).toEqual(first.result.caveats);
      expect(first.result.messages).toEqual(HIDDEN_ROW_MESSAGES);
      expect(second.result.messages).toEqual(first.result.messages);

      for (const { result } of [first, second]) {
        const text = (queryWonder.format!(result)[0] as { type: 'text'; text: string }).text;
        for (const message of HIDDEN_ROW_MESSAGES) expect(text).toContain(message);
        expect(text).toContain('Population figures are bridged-race estimates.');
      }
    });

    it('composes the page guidance with the other notices instead of replacing them', async () => {
      /**
       * `ctx.enrich.truncated()` writes `notice` and last-wins over every other notice call,
       * so the continuation guidance has to arrive carrying the suppression and hidden-row
       * warnings rather than after them.
       */
      const { enrichment } = await page({ limit: 5 });

      expect(enrichment.truncated).toBe(true);
      expect(enrichment.notice).toContain('offset=5');
      expect(enrichment.notice).toContain('withheld by CDC for confidentiality');
      expect(enrichment.notice).toContain('CDC withheld whole rows');
    });

    it('still reads an empty table as "no rows matched" rather than a spent offset', async () => {
      mockQuery.mockResolvedValue({ ...sampleResult, rows: [], rowCount: 0 });
      const ctx = createMockContext({ errors: queryWonder.errors });
      const result = await queryWonder.handler(
        queryWonder.input.parse({ group_by: ['year'], limit: 10 }),
        ctx,
      );

      expect(result.rowCount).toBe(0);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(0);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.notice).toContain('No rows matched');
      expect(enrichment.notice).not.toContain('past the end');
    });

    it('counts only the page when tallying suppression and other status tokens', async () => {
      const { result, enrichment } = await page({ limit: 2 });

      expect(result.suppressedCount).toBe(0);
      expect(result.cellNotes).toEqual([{ row: 1, column: 'crude_rate', token: 'Unreliable' }]);
      expect(enrichment.notice).toContain('Unreliable (1 cell)');
      expect(enrichment.notice).not.toContain('withheld by CDC for confidentiality');
    });

    it('leaves limit unset and offset at zero by default', () => {
      const input = queryWonder.input.parse({});
      expect(input.limit).toBeUndefined();
      expect(input.offset).toBe(0);
    });
  });

  describe('input validation', () => {
    it('defaults group_by to year and sex to all', () => {
      const input = queryWonder.input.parse({});
      expect(input.group_by).toEqual(['year']);
      expect(input.sex).toBe('all');
    });

    it('defaults database to the one the tool queried before the selector existed', () => {
      expect(queryWonder.input.parse({}).database).toBe('underlying_1999_2020');
    });

    it('rejects a database the enum does not list', () => {
      expect(() => queryWonder.input.parse({ database: 'D176' })).toThrow();
      expect(() => queryWonder.input.parse({ database: 'natality' })).toThrow();
    });

    it('publishes the union year bounds in the schema rather than one database’s span', () => {
      /**
       * The bounds have to reach the client as a plain numeric range — that is the whole
       * reason the per-database span is enforced in the handler instead.
       */
      const schema = z.toJSONSchema(queryWonder.input) as unknown as {
        properties: {
          year_range: { properties: { from: { minimum: number }; to: { maximum: number } } };
        };
      };
      const { from, to } = schema.properties.year_range.properties;
      expect(from.minimum).toBe(1999);
      expect(to.maximum).toBe(new Date().getUTCFullYear());
    });

    it('accepts an ICD-10 range for mcd_icd10 and rejects a malformed one', () => {
      expect(queryWonder.input.parse({ mcd_icd10: 'S00-T98' }).mcd_icd10).toBe('S00-T98');
      expect(queryWonder.input.parse({ mcd_icd10: '' }).mcd_icd10).toBe('');
      expect(() => queryWonder.input.parse({ mcd_icd10: 'respiratory' })).toThrow();
    });

    it('says on the race grouping that the two race families are not comparable', () => {
      /**
       * Bridged race collapses Asian and Pacific Islander into one group; single race splits
       * them and adds a multiracial category. A reader who splices the two series produces a
       * discontinuity that looks like a finding.
       */
      expect(queryWonder.input.shape.group_by.description).toContain('bridged');
      expect(queryWonder.input.shape.database.description).toContain('not comparable');
    });

    it('rejects more than four group-by dimensions', () => {
      expect(() =>
        queryWonder.input.parse({ group_by: ['year', 'age_group', 'sex', 'race', 'year'] }),
      ).toThrow();
    });

    it('rejects cause_of_death as a grouping (it is a filter)', () => {
      expect(() => queryWonder.input.parse({ group_by: ['cause_of_death'] })).toThrow();
    });

    it('accepts a valid ICD-10 range and rejects a malformed code', () => {
      expect(queryWonder.input.parse({ cause_icd10: 'C00-C97' }).cause_icd10).toBe('C00-C97');
      expect(() => queryWonder.input.parse({ cause_icd10: 'cancer' })).toThrow();
    });

    it('rejects a year range where from is after to', () => {
      expect(() => queryWonder.input.parse({ year_range: { from: 2020, to: 2018 } })).toThrow();
    });

    it('rejects an unknown age group', () => {
      expect(() => queryWonder.input.parse({ age_groups: ['30-40'] })).toThrow();
    });

    it('offers the whole .V5 value list, Not Stated included', () => {
      /**
       * The twelve values below are `.V5` as every mortality database's request form lists it.
       * Dropping `NS` makes deaths with no recorded age unselectable: a filter naming the
       * eleven ten-year groups then returns fewer deaths than the same query unfiltered, with
       * nothing in the result explaining the gap.
       */
      expect(queryWonder.input.parse({ age_groups: ['NS'] }).age_groups).toEqual(['NS']);
      const schema = z.toJSONSchema(queryWonder.input) as unknown as {
        properties: { age_groups: { items: { enum: string[] } } };
      };
      expect(schema.properties.age_groups.items.enum).toEqual([
        '1',
        '1-4',
        '5-14',
        '15-24',
        '25-34',
        '35-44',
        '45-54',
        '55-64',
        '65-74',
        '75-84',
        '85+',
        'NS',
      ]);
    });

    it('says what the Not Stated group covers and what leaving it out costs', () => {
      const description = queryWonder.input.shape.age_groups.description ?? '';
      expect(description).toContain('NS');
      expect(description).toContain('not recorded');
      expect(description).toContain('fewer deaths');
    });

    it('accepts the withheld-cause marker on both cause inputs, which no ICD-10 form allows', () => {
      /** `999--999` is CDC's own finder value, not an ICD-10 code — the pattern cannot spell it. */
      expect(queryWonder.input.parse({ cause_icd10: '999--999' }).cause_icd10).toBe('999--999');
      expect(queryWonder.input.parse({ mcd_icd10: '999--999' }).mcd_icd10).toBe('999--999');
      expect(() => queryWonder.input.parse({ cause_icd10: '999-999' })).toThrow();
    });

    it('states that age_groups matches any of the listed groups', () => {
      /**
       * Every multi-value filter on this surface unions its values. Leaving that implied
       * lets a reader take a second age group as a narrowing conjunction, which selects
       * nothing — a death falls in exactly one age group.
       */
      expect(queryWonder.input.shape.age_groups.description).toContain('any of the listed');
    });
  });

  describe('format', () => {
    it('renders a markdown table with a caveats section', () => {
      const blocks = queryWonder.format!(sampleResult);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('D76 — Underlying Cause of Death, 1999-2020 — 2 rows');
      expect(text).toContain(
        '| year | sex | deaths | population | crude_rate | age_adjusted_rate |',
      );
      expect(text).toContain('| 2019 | Female | 283725 | 166582199 | 170.3 | 126.2 |');
      expect(text).toContain('**Caveats:**');
    });

    it('renders suppressed cells as the Suppressed token and notes the count', () => {
      const blocks = queryWonder.format!({
        ...sampleResult,
        rows: [
          {
            year: '2020',
            sex: 'Female',
            deaths: null,
            population: 100,
            crude_rate: null,
            age_adjusted_rate: null,
          },
        ],
        rowCount: 1,
        cellNotes: [{ row: 0, column: 'deaths', token: 'Suppressed' }],
        suppressedCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('| 2020 | Female | Suppressed | 100 |  |  |');
      expect(text).toContain('1 cell(s) withheld by CDC for confidentiality');
      // The itemized block is for cells CDC published-but-flagged; a withheld cell
      // must not also be listed there, which would contradict the suppression line.
      expect(text).not.toContain('not withheld');
    });

    it('renders an unreliable cell as its token and itemizes it below the table', () => {
      const blocks = queryWonder.format!(unreliableResult);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('| 15-24 years | 10 | 42687510 | Unreliable |');
      expect(text).toContain('row 0, `crude_rate` — `Unreliable`');
      expect(text).toContain('fewer than 20 deaths');
      expect(text).not.toContain('withheld by CDC for confidentiality');
    });

    it('keeps a cell containing a newline or pipe inside its own row', () => {
      /**
       * The escaping here guarded pipes but not line breaks, so a multi-line measure label
       * would terminate its row and spill the rest of the table into loose text.
       */
      const blocks = queryWonder.format!({
        ...sampleResult,
        rows: [{ year: '2019\n', sex: 'Female | Male', deaths: 1, population: 2 }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      const dataRow = text.split('\n').find((l) => l.includes('Female'));
      expect(dataRow).toBe('| 2019 | Female \\| Male | 1 | 2 |');
    });

    it('renders every caveat, not a leading slice', () => {
      const caveats = Array.from({ length: 18 }, (_, i) => `Caveat number ${i + 1}.`);
      const blocks = queryWonder.format!({ ...sampleResult, caveats });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      for (const caveat of caveats) expect(text).toContain(caveat);
    });

    it('renders the CDC notices below the table so a filtered row set is visible in content[]', () => {
      const blocks = queryWonder.format!({ ...sampleResult, messages: HIDDEN_ROW_MESSAGES });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('rows may have been withheld');
      for (const message of HIDDEN_ROW_MESSAGES) expect(text).toContain(message);
    });

    it('says rows were withheld rather than "no rows matched" on an empty filtered result', () => {
      const blocks = queryWonder.format!({
        ...sampleResult,
        rows: [],
        rowCount: 0,
        messages: HIDDEN_ROW_MESSAGES,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('not evidence that nothing matched');
      expect(text).not.toContain('No rows matched');
      expect(text).toContain('Rows with suppressed Deaths are hidden.');
    });

    it('renders an empty-state message and still carries the caveats when there are no rows', () => {
      const blocks = queryWonder.format!({
        ...sampleResult,
        rows: [],
        rowCount: 0,
        caveats: ['Population figures are bridged-race estimates.', 'Deaths are national totals.'],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No rows matched');
      expect(text).toContain('**Caveats:**');
      expect(text).toContain('Population figures are bridged-race estimates.');
      expect(text).toContain('Deaths are national totals.');
    });
  });
});
