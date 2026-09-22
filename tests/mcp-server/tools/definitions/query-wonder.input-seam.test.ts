/**
 * @fileoverview cdc_query_wonder input handling run through the full tool contract against the
 * real WonderService, with only `fetch` faked: the relational input checks that must settle
 * before any WONDER request, and ICD-10 code lists on both cause finders. Every "no request"
 * assertion counts calls at the fetch boundary, and the request assertions read the
 * `request_xml` the service actually sent.
 * @module tests/mcp-server/tools/definitions/query-wonder.input-seam
 */

import { readFileSync } from 'node:fs';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/wonder/${name}`, import.meta.url), 'utf8');
}

/** D76, underlying cause X40–X44 sent as five finder values, grouped by year, 2018–2019. */
const D76_X40_X44 = fixture('d76-x40-x44-by-year-2018-2019.response.xml');
/** D77, the overdose underlying-cause set AND the opioid multiple-cause set, 2019. */
const D77_OVERDOSE_OPIOID = fixture('d77-overdose-ucd-opioid-mcd-2019.response.xml');
/** D158's HTTP 500 body for a request grouping by race twice. */
const D158_DUPLICATE_RACE = fixture('d158-duplicate-race-group-by.response.xml');

/** The overdose underlying-cause definition CDC's own caveats use: X40–X44, X60–X64, X85, Y10–Y14. */
const OVERDOSE_UCD = [
  'X40',
  'X41',
  'X42',
  'X43',
  'X44',
  'X60',
  'X61',
  'X62',
  'X63',
  'X64',
  'X85',
  'Y10',
  'Y11',
  'Y12',
  'Y13',
  'Y14',
];
/** Opioid-involved: T40.0–T40.4 and T40.6 anywhere on the certificate. */
const OPIOID_MCD = ['T40.0', 'T40.1', 'T40.2', 'T40.3', 'T40.4', 'T40.6'];

/** A one-row year table with only the three always-requested measures. */
const THREE_MEASURE_TABLE = `<results><data-table>
  <r><c l="2019"/><c v="4,000"/><c v="40,000,000"/><c v="10.0"/></r>
</data-table></results>`;
/** A one-row year table carrying the age-adjusted column too. */
const FOUR_MEASURE_TABLE = `<results><data-table>
  <r><c l="2019"/><c v="4,000"/><c v="40,000,000"/><c v="10.0"/><c v="9.5"/></r>
</data-table></results>`;

const INVALID_QUERY_RECOVERY = queryWonder.errors?.find(
  (e) => e.reason === 'invalid_query',
)?.recovery;

let fetchSpy: MockInstance<typeof fetch>;

function respondWith(body: string, status = 200): void {
  fetchSpy.mockImplementation(async () => new Response(body, { status }));
}

/** The `request_xml` of every request that reached the fetch boundary, in order. */
function sentRequests(): string[] {
  return fetchSpy.mock.calls.map(([, init]) => {
    const body = init?.body;
    if (!(body instanceof URLSearchParams)) throw new Error('expected a form-encoded body');
    return body.get('request_xml') ?? '';
  });
}

/** The `<value>`s one `<parameter>` carries in a request document. */
function values(xml: string, name: string): string[] | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(
    new RegExp(`<parameter><name>${escaped}</name>((?:<value>[^<]*</value>)*)</parameter>`),
  );
  if (!match) return;
  return [...(match[1] ?? '').matchAll(/<value>([^<]*)<\/value>/g)].map((m) => m[1] ?? '');
}

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

function textOf(result: ContractResult): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
}

function errorOf(result: ContractResult) {
  return (
    result.structuredContent as {
      error: {
        code: number;
        message: string;
        data: { reason: string; recovery?: { hint: string } };
      };
    }
  ).error;
}

function structuredOf(result: ContractResult) {
  return result.structuredContent as {
    rows: Record<string, string | number | null>[];
    effectiveQuery: string;
  };
}

/** Asserts a declared invalid_query rejection, identical on both surfaces, before any request. */
function expectInvalidQueryBeforeRequest(result: ContractResult): { message: string } {
  expect(result.isError).toBe(true);
  const error = errorOf(result);
  expect(error.data.reason).toBe('invalid_query');
  expect(error.data.recovery?.hint).toBe(INVALID_QUERY_RECOVERY);
  const text = textOf(result);
  expect(text).toContain('invalid_query');
  expect(text).toContain(INVALID_QUERY_RECOVERY);
  expect(fetchSpy).not.toHaveBeenCalled();
  return { message: error.message };
}

describe('cdc_query_wonder input handling over the real service', () => {
  beforeEach(() => {
    initWonderService();
    // Nothing here may reach the live API: a test that serves no fixture fails loudly.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('relational checks settle before any request', () => {
    it('fails a reversed year_range as invalid_query, naming the range, without a request', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        year_range: { from: 2020, to: 2019 },
      });
      const { message } = expectInvalidQueryBeforeRequest(result);
      expect(message).toContain('2020');
      expect(message).toContain('2019');
    });

    it('fails a reversed year_range the selected database would otherwise reject for its span', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        year_range: { from: 2024, to: 2019 },
      });
      const { message } = expectInvalidQueryBeforeRequest(result);
      expect(message).toMatch(/from.*to/);
    });

    it('fails a repeated group_by dimension as invalid_query, naming it, without a request', async () => {
      respondWith(D158_DUPLICATE_RACE, 500);
      const result = await runToolContract(queryWonder, {
        database: 'underlying_2018_2024',
        group_by: ['race', 'race'],
        year_range: { from: 2024, to: 2024 },
      });
      const { message } = expectInvalidQueryBeforeRequest(result);
      expect(message).toContain('"race"');
    });

    it('treats a repeated age group as the single group it names', async () => {
      /**
       * One age group cannot be standardized across, so the age-adjusted rate is dropped. A
       * repeated value used to read as two groups on both sides — this server kept the column
       * and WONDER computed it — returning the crude rate under the age-adjusted name.
       */
      respondWith(THREE_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        age_groups: ['25-34', '25-34'],
        year_range: { from: 2019, to: 2019 },
      });

      expect(result.isError).toBeFalsy();
      const [xml] = sentRequests();
      expect(xml).toBeDefined();
      expect(values(xml!, 'O_aar')).toEqual(['aar_none']);
      expect(values(xml!, 'V_D76.V5')).toEqual(['25-34']);

      const structured = structuredOf(result);
      expect(structured.rows[0]).not.toHaveProperty('age_adjusted_rate');
      expect(structured.effectiveQuery).toContain('ages 25-34, ');
      expect(structured.effectiveQuery).not.toContain('25-34,25-34');
      expect(textOf(result)).not.toContain('age_adjusted_rate');
    });

    it('keeps the age-adjusted rate for two distinct age groups', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        age_groups: ['25-34', '35-44', '25-34'],
        year_range: { from: 2019, to: 2019 },
      });

      const [xml] = sentRequests();
      expect(values(xml!, 'O_aar')).toEqual(['aar_std']);
      expect(values(xml!, 'V_D76.V5')).toEqual(['25-34', '35-44']);
      expect(structuredOf(result).rows[0]).toHaveProperty('age_adjusted_rate', 9.5);
    });
  });

  describe('a single cause value', () => {
    it('sends one cause code as one finder value', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: 'X40',
        year_range: { from: 2019, to: 2019 },
      });

      const [xml] = sentRequests();
      expect(values(xml!, 'F_D76.V2')).toEqual(['X40']);
      expect(values(xml!, 'I_D76.V2')).toEqual(['X40']);
      expect(structuredOf(result).effectiveQuery).toContain('underlying cause X40');
    });

    it('reads an empty cause string as every cause', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: '',
        year_range: { from: 2019, to: 2019 },
      });

      const [xml] = sentRequests();
      expect(values(xml!, 'F_D76.V2')).toEqual(['*All*']);
      expect(structuredOf(result).effectiveQuery).not.toContain('cause');
    });

    it('sends one multiple-cause code on the .V13 finder in range mode', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      await runToolContract(queryWonder, {
        database: 'multiple_1999_2020',
        group_by: ['year'],
        mcd_icd10: 'J00-J98',
        year_range: { from: 2019, to: 2019 },
      });

      const [xml] = sentRequests();
      expect(values(xml!, 'F_D77.V13')).toEqual(['J00-J98']);
      expect(values(xml!, 'O_V13_fmode')).toEqual(['freg']);
      expect(values(xml!, 'F_D77.V2')).toEqual(['*All*']);
    });
  });

  describe('ICD-10 code lists', () => {
    it('sends each listed cause as its own finder value and returns one series', async () => {
      respondWith(D76_X40_X44);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: ['X40', 'X41', 'X42', 'X43', 'X44'],
        year_range: { from: 2018, to: 2019 },
      });

      expect(result.isError).toBeFalsy();
      const [xml] = sentRequests();
      expect(values(xml!, 'F_D76.V2')).toEqual(['X40', 'X41', 'X42', 'X43', 'X44']);
      expect(values(xml!, 'I_D76.V2')).toEqual(['X40 X41 X42 X43 X44']);

      const structured = structuredOf(result);
      expect(structured.rows.map((r) => [r.year, r.deaths])).toEqual([
        ['2018', 58908],
        ['2019', 62172],
      ]);
      expect(structured.effectiveQuery).toContain(
        'underlying cause X40 or X41 or X42 or X43 or X44',
      );

      const text = textOf(result);
      expect(text).toContain('| 2018 | 58908 |');
      expect(text).toContain('| 2019 | 62172 |');
      expect(text).toContain('underlying cause X40 or X41 or X42 or X43 or X44');
    });

    it('sends a list on both finders of a multiple-cause database, which WONDER ANDs', async () => {
      respondWith(D77_OVERDOSE_OPIOID);
      const result = await runToolContract(queryWonder, {
        database: 'multiple_1999_2020',
        group_by: ['year'],
        cause_icd10: OVERDOSE_UCD,
        mcd_icd10: OPIOID_MCD,
        year_range: { from: 2019, to: 2019 },
      });

      expect(result.isError).toBeFalsy();
      const [xml] = sentRequests();
      expect(values(xml!, 'F_D77.V2')).toEqual(OVERDOSE_UCD);
      expect(values(xml!, 'I_D77.V2')).toEqual([OVERDOSE_UCD.join(' ')]);
      expect(values(xml!, 'F_D77.V13')).toEqual(OPIOID_MCD);
      expect(values(xml!, 'I_D77.V13')).toEqual([OPIOID_MCD.join(' ')]);
      expect(values(xml!, 'O_V13_fmode')).toEqual(['freg']);

      const structured = structuredOf(result);
      expect(structured.rows).toEqual([
        {
          year: '2019',
          deaths: 49860,
          population: 328239523,
          crude_rate: 15.2,
          age_adjusted_rate: 15.5,
        },
      ]);
      expect(structured.effectiveQuery).toContain(`any listed cause ${OPIOID_MCD.join(' or ')}`);
      expect(textOf(result)).toContain('| 2019 | 49860 | 328239523 | 15.2 | 15.5 |');
    });

    it('sends lists on both finders of the provisional database, the withheld marker among them', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        database: 'provisional',
        group_by: ['year'],
        cause_icd10: ['X40-X49', '999--999'],
        mcd_icd10: ['T40.1', 'T40.4'],
        year_range: { from: 2024, to: 2024 },
      });

      expect(result.isError).toBeFalsy();
      const [xml] = sentRequests();
      expect(values(xml!, 'F_D176.V2')).toEqual(['X40-X49', '999--999']);
      expect(values(xml!, 'F_D176.V13')).toEqual(['T40.1', 'T40.4']);
    });

    it('sends a one-entry list exactly as it sends the bare code', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: ['X40'],
        year_range: { from: 2019, to: 2019 },
      });
      // A fresh service has no previous response to space from, so the second call goes out now.
      initWonderService();
      await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: 'X40',
        year_range: { from: 2019, to: 2019 },
      });

      const [fromList, fromString] = sentRequests();
      expect(fromList).toBeDefined();
      expect(fromList).toBe(fromString);
    });

    it('drops repeated codes, which the OR makes redundant', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        database: 'multiple_2018_2024',
        group_by: ['year'],
        cause_icd10: ['X40', 'X41', 'X40'],
        mcd_icd10: ['T40.1', 'T40.1'],
        year_range: { from: 2019, to: 2019 },
      });

      const [xml] = sentRequests();
      expect(values(xml!, 'F_D157.V2')).toEqual(['X40', 'X41']);
      expect(values(xml!, 'F_D157.V13')).toEqual(['T40.1']);
      expect(structuredOf(result).effectiveQuery).toContain('underlying cause X40 or X41, ');
      expect(structuredOf(result).effectiveQuery).toContain('any listed cause T40.1, ');
    });

    it('accepts a list at the maximum length and sends every entry', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const codes = Array.from({ length: 50 }, (_, i) => `X${String(i + 10).padStart(2, '0')}`);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: codes,
        year_range: { from: 2019, to: 2019 },
      });

      expect(result.isError).toBeFalsy();
      expect(values(sentRequests()[0]!, 'F_D76.V2')).toEqual(codes);
    });

    it.each([
      ['an empty list', []],
      ['a list one past the maximum', Array.from({ length: 51 }, (_, i) => `X${i + 10}`)],
      ['a list holding an empty string', ['X40', '']],
      ['a list holding a malformed code', ['X40', 'overdose']],
    ])('rejects %s at the schema, without a request', async (_label, codes) => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        group_by: ['year'],
        cause_icd10: codes,
      });

      expect(result.isError).toBe(true);
      expect(errorOf(result).data.reason).toBe('invalid_arguments');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['underlying_1999_2020', 'cause_icd10'],
      ['underlying_2018_2024', 'cause_icd10'],
      ['multiple_1999_2020', 'mcd_icd10'],
      ['multiple_2018_2024', 'mcd_icd10'],
    ] as const)(
      'rejects the withheld-cause marker inside a list on %s (%s), without a request',
      async (database, field) => {
        respondWith(FOUR_MEASURE_TABLE);
        const result = await runToolContract(queryWonder, {
          database,
          group_by: ['year'],
          [field]: ['I21', '999--999'],
        });
        const { message } = expectInvalidQueryBeforeRequest(result);
        expect(message).toContain('database "provisional"');
      },
    );

    it('rejects an mcd_icd10 list against an underlying-cause database, without a request', async () => {
      respondWith(FOUR_MEASURE_TABLE);
      const result = await runToolContract(queryWonder, {
        database: 'underlying_2018_2024',
        group_by: ['year'],
        mcd_icd10: ['T40.1', 'T40.4'],
      });
      const { message } = expectInvalidQueryBeforeRequest(result);
      expect(message).toContain('multiple_2018_2024');
    });
  });
});
