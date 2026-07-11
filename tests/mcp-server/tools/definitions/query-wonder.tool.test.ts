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
  suppressedCount: 0,
  columns: ['year', 'sex', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
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
    mockQuery.mockResolvedValue({ ...sampleResult, suppressedCount: 3 });
    const ctx = createMockContext();
    await queryWonder.handler(queryWonder.input.parse({ group_by: ['year'] }), ctx);
    expect(getEnrichment(ctx).notice).toContain('suppressed');
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

    it('renders suppressed cells as blank and notes the suppression count', () => {
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
        suppressedCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('| 2020 | Female |  | 100 |  |  |');
      expect(text).toContain('1 cell(s) suppressed');
    });

    it('renders an empty-state message when there are no rows', () => {
      const blocks = queryWonder.format!({ ...sampleResult, rows: [], rowCount: 0 });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No rows matched');
    });
  });
});
