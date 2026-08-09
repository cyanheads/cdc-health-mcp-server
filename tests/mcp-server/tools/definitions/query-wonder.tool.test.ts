/**
 * @fileoverview Tests for cdc_query_wonder tool.
 * @module tests/mcp-server/tools/definitions/query-wonder
 */

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
  caveats: ['A caveat.'],
  cellNotes: [],
  suppressedCount: 0,
  columns: ['year', 'sex', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
};

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
    const ctx = createMockContext();
    const input = queryWonder.input.parse({ group_by: ['year', 'sex'], cause_icd10: 'C00-C97' });
    const result = await queryWonder.handler(input, ctx);

    expect(result.rowCount).toBe(2);
    expect(result.database).toBe('D76');
    expect(result.caveats).toEqual(['A caveat.']);
    expect(result.suppressedCount).toBe(0);
    // internal ordering column list is not part of the tool output
    expect((result as Record<string, unknown>).columns).toBeUndefined();
  });

  it('maps friendly inputs to service options (empty cause coerced away)', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
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
        groupBy: ['year'],
        sex: 'male',
        ageGroups: ['25-34'],
        yearRange: { from: 2018, to: 2020 },
      },
      ctx.signal,
    );
  });

  it('enriches with a human-readable query summary', async () => {
    mockQuery.mockResolvedValue(sampleResult);
    const ctx = createMockContext();
    const input = queryWonder.input.parse({ group_by: ['year', 'sex'], cause_icd10: 'C00-C97' });
    await queryWonder.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('grouped by year, sex');
    expect(enrichment.effectiveQuery).toContain('cause C00-C97');
    expect(enrichment.notice).toBeUndefined();
  });

  it('notices when no rows matched', async () => {
    mockQuery.mockResolvedValue({ ...sampleResult, rows: [], rowCount: 0 });
    const ctx = createMockContext();
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    expect(getEnrichment(ctx).notice).toContain('No rows matched');
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
    const ctx = createMockContext();
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('3 cell(s) were withheld');
    // Suppression is withholding — it must never be tallied into the "not withheld" phrasing.
    expect(notice).not.toContain('not withheld');
    expect(notice).not.toContain('Suppressed (3 cells)');
  });

  it('returns cellNotes and notices unreliable cells as published, not withheld', async () => {
    mockQuery.mockResolvedValue(unreliableResult);
    const ctx = createMockContext();
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
    const ctx = Object.assign(createMockContext(), {
      recoveryFor: (reason: string) => ({ recovery: `recover ${reason}` }),
      fail: (reason: string, message: string, data: Record<string, unknown>) =>
        new McpError(JsonRpcErrorCode.ValidationError, message, { reason, ...data }),
    });
    await expect(
      queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'invalid_query' } });
  });

  describe('input validation', () => {
    it('defaults group_by to year and sex to all', () => {
      const input = queryWonder.input.parse({});
      expect(input.group_by).toEqual(['year']);
      expect(input.sex).toBe('all');
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
      expect(text).toContain('D76 — 2 rows');
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
        columns: ['year', 'sex', 'deaths', 'population'],
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
