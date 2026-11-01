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
import {
  WONDER_AGE_GROUPS,
  WONDER_DATABASES,
  type WonderAgeGroup,
  type WonderGroupBy,
} from '@/services/wonder/types.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';
import { contentText as textOf } from '../../../helpers/contract-text.js';

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

    describe('"NS" beside only some of the known age groups', () => {
      /** CDC refuses Not Stated combined with a partial list of known groups. */
      const KNOWN = WONDER_AGE_GROUPS.filter((group) => group !== 'NS');

      it.each<[string, WonderAgeGroup[]]>([
        ['one known group', ['25-34', 'NS']],
        ['ten known groups', [...KNOWN.filter((group) => group !== '85+'), 'NS']],
        ['a repeated NS beside one group', ['NS', '25-34', 'NS']],
      ])(
        'fails %s as invalid_query naming the three fixes, without a request',
        async (_label, ageGroups) => {
          respondWith(FOUR_MEASURE_TABLE);
          const result = await runToolContract(queryWonder, {
            group_by: ['year'],
            age_groups: ageGroups,
            year_range: { from: 2020, to: 2020 },
          });
          const { message } = expectInvalidQueryBeforeRequest(result);
          expect(message).toBe(
            'age_groups combines "NS" (age not stated) with only some of the known age groups, which CDC WONDER refuses. List "NS" on its own to count deaths with no recorded age, drop "NS" to keep the listed groups, or omit age_groups for all ages, deaths with no recorded age included.',
          );
        },
      );

      it.each(WONDER_DATABASES)('applies on %s', async (database) => {
        respondWith(FOUR_MEASURE_TABLE);
        const result = await runToolContract(queryWonder, {
          database,
          group_by: ['year'],
          age_groups: ['25-34', 'NS'],
        });
        const { message } = expectInvalidQueryBeforeRequest(result);
        expect(message).toMatch(/^age_groups combines "NS"/);
      });

      it.each<[string, WonderAgeGroup[] | undefined, string[] | undefined]>([
        ['NS alone', ['NS'], ['NS']],
        ['a repeated NS', ['NS', 'NS'], ['NS']],
        ['all twelve values', [...KNOWN, 'NS'], [...KNOWN, 'NS']],
        ['known groups only', ['25-34', '35-44'], ['25-34', '35-44']],
        ['an empty list', [], undefined],
        ['an omitted age_groups', undefined, undefined],
      ])('still queries %s, in one request', async (_label, ageGroups, sent) => {
        respondWith(FOUR_MEASURE_TABLE);
        const result = await runToolContract(queryWonder, {
          group_by: ['year'],
          ...(ageGroups ? { age_groups: ageGroups } : {}),
          year_range: { from: 2020, to: 2020 },
        });
        expect(result.isError).toBeFalsy();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(values(sentRequests()[0]!, 'V_D76.V5')).toEqual(sent ?? ['*All*']);
      });
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

    describe('leading_causes beside another grouping', () => {
      /** WONDER's own HTTP 500 for leading causes grouped beside year, captured unchanged. */
      const REJECTED = fixture('d76-leading-causes-beside-year-rejected.response.xml');

      it.each<[WonderGroupBy[], string]>([
        [['leading_causes', 'year'], 'year'],
        [['sex', 'leading_causes', 'race'], 'sex, race'],
      ])(
        'fails %j as invalid_query naming group_by, without a request',
        async (groupBy, others) => {
          respondWith(REJECTED, 500);
          const result = await runToolContract(queryWonder, { group_by: groupBy });
          const { message } = expectInvalidQueryBeforeRequest(result);
          expect(message).toBe(
            `group_by pairs leading_causes with ${others}, and CDC WONDER ranks the 15 leading causes only on their own: it refuses any other grouping beside them. Group by leading_causes alone — the filters still apply — or group by cause_113, whose list holds the same rankable causes (marked "#") and combines with other dimensions.`,
          );
        },
      );

      it('reports a repeated leading_causes as the repeat it is', async () => {
        respondWith(REJECTED, 500);
        const result = await runToolContract(queryWonder, {
          group_by: ['leading_causes', 'leading_causes'],
        });
        const { message } = expectInvalidQueryBeforeRequest(result);
        expect(message).toContain('group_by lists "leading_causes" more than once');
      });

      it('queries leading_causes alone, with a cause filter, in one request', async () => {
        respondWith(fixture('d158-leading-causes-2023.response.xml'));
        const result = await runToolContract(queryWonder, {
          database: 'underlying_2018_2024',
          group_by: ['leading_causes'],
          cause_icd10: 'V01-Y89',
          year_range: { from: 2023, to: 2023 },
        });
        expect(result.isError).toBeFalsy();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [xml] = sentRequests();
        expect(values(xml!, 'B_1')).toEqual(['D158.V28']);
        expect(values(xml!, 'B_2')).toEqual(['*None*']);
        expect(values(xml!, 'F_D158.V2')).toEqual(['V01-Y89']);
      });
    });

    describe('the bound on a table’s rows', () => {
      /** WONDER's HTTP 500 to a refused request — what a request that should not go out returns. */
      const REFUSED = '<page><message>This request should never reach WONDER.</message></page>';

      it('refuses a grouping that could reach 10,080 rows, naming each factor, without a request', async () => {
        respondWith(REFUSED, 500);
        const result = await runToolContract(queryWonder, {
          group_by: ['icd_chapter', 'year', 'age_group', 'sex'],
          year_range: { from: 2000, to: 2020 },
        });
        const { message } = expectInvalidQueryBeforeRequest(result);
        expect(message).toBe(
          "group_by icd_chapter, year, age_group, sex can produce up to 10,080 rows on D76 (icd_chapter 20 × year 21 × age_group 12 × sex 2), past the 10,000-row bound on one query's table — CDC WONDER takes longer than the 20-second request deadline to answer a table that large. Narrow year_range, filter sex or age_groups, or drop a dimension from group_by until the product is 10,000 or less; a cause filter does not lower it.",
        );
      });

      it.each<[string, Record<string, unknown>]>([
        [
          'one year fewer (9,600 rows)',
          {
            group_by: ['icd_chapter', 'year', 'age_group', 'sex'],
            year_range: { from: 2001, to: 2020 },
          },
        ],
        [
          'the same grouping filtered to one sex (5,040 rows)',
          {
            group_by: ['icd_chapter', 'year', 'age_group', 'sex'],
            year_range: { from: 2000, to: 2020 },
            sex: 'female',
          },
        ],
        [
          'the largest grouping without a cause dimension (2,112 rows)',
          { group_by: ['year', 'age_group', 'sex', 'race'] },
        ],
        [
          'sub-chapters by year and sex over every D76 year (7,788 rows)',
          { group_by: ['icd_subchapter', 'year', 'sex'] },
        ],
        [
          'year, month and sex over every D76 year, the month already naming its year (528 rows)',
          { group_by: ['year', 'month', 'sex'] },
        ],
      ])('queries %s in one request', async (_label, input) => {
        respondWith(FOUR_MEASURE_TABLE);
        const result = await runToolContract(queryWonder, input);
        expect(result.isError).toBeFalsy();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it.each<[string, Record<string, unknown>, string]>([
        [
          'sub-chapters by year, age and race — past WONDER’s own 75,000-row ceiling',
          { group_by: ['icd_subchapter', 'year', 'age_group', 'race'] },
          'up to 186,912 rows on D76',
        ],
        [
          'months by age, sex and race',
          { group_by: ['month', 'age_group', 'sex', 'race'] },
          'up to 25,344 rows on D76 (month 264 × age_group 12 × sex 2 × race 4), past',
        ],
        [
          'years and months by age and race, counting the year once inside its month',
          { group_by: ['year', 'month', 'age_group', 'race'] },
          'up to 12,672 rows on D76 (year 1 × month 264 × age_group 12 × race 4; month already enumerates year), past',
        ],
        [
          'the 113-cause list by year, sex and race on the provisional database',
          { database: 'provisional', group_by: ['cause_113', 'year', 'sex', 'race'] },
          'rows on D176 (cause_113 138 × year',
        ],
      ])('refuses %s', async (_label, input, named) => {
        respondWith(REFUSED, 500);
        const { message } = expectInvalidQueryBeforeRequest(
          await runToolContract(queryWonder, input),
        );
        expect(message).toContain(named);
      });
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
      /** Captured before the request asked for intervals, so every bound reads null. */
      expect(structured.rows).toEqual([
        {
          year: '2019',
          deaths: 49860,
          population: 328239523,
          crude_rate: 15.2,
          crude_rate_lower: null,
          crude_rate_upper: null,
          age_adjusted_rate: 15.5,
          age_adjusted_rate_lower: null,
          age_adjusted_rate_upper: null,
        },
      ]);
      expect(structured.effectiveQuery).toContain(`any listed cause ${OPIOID_MCD.join(' or ')}`);
      expect(textOf(result)).toContain('| 2019 | 49860 | 328239523 | 15.2 |  |  | 15.5 |  |  |');
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

    describe('the withheld-cause code a sub-chapter row carries', () => {
      /**
       * Grouped by icd_subchapter, the provisional database's withheld-cause row carries
       * `999-999` as its cause_code; by chapter it is `999--999`. Only `999--999` is verified as
       * a finder value, so the sub-chapter form is accepted and sent as that.
       */
      it.each<[string, string | string[]]>([
        ['the sub-chapter code', '999-999'],
        ['both forms in one list', ['999-999', '999--999']],
      ])('sends %s as the one finder value 999--999', async (_label, cause) => {
        respondWith(FOUR_MEASURE_TABLE);
        const result = await runToolContract(queryWonder, {
          database: 'provisional',
          group_by: ['year'],
          cause_icd10: cause,
          year_range: { from: 2024, to: 2024 },
        });

        expect(result.isError).toBeFalsy();
        const [xml] = sentRequests();
        expect(values(xml!, 'F_D176.V2')).toEqual(['999--999']);
        expect(values(xml!, 'I_D176.V2')).toEqual(['999--999']);
        expect(structuredOf(result).effectiveQuery).toContain('underlying cause 999--999, years');
        expect(textOf(result)).toContain('underlying cause 999--999');
        expect(xml).not.toContain('999-999<');
      });

      it('rejects the sub-chapter code off the provisional database as the marker it is', async () => {
        respondWith(FOUR_MEASURE_TABLE);
        const result = await runToolContract(queryWonder, {
          group_by: ['year'],
          cause_icd10: '999-999',
        });
        const { message } = expectInvalidQueryBeforeRequest(result);
        expect(message).toContain('"999--999" is CDC\'s marker');
        expect(message).toContain('database "provisional"');
      });
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
      ['cause_icd10', 'underlying_1999_2020'],
      ['cause_icd10', 'multiple_1999_2020'],
      ['mcd_icd10', 'multiple_1999_2020'],
      ['mcd_icd10', 'underlying_1999_2020'],
    ] as const)(
      'sends an empty %s list on %s exactly as it sends an omitted one',
      async (field, database) => {
        /**
         * An empty union filters nothing, as `age_groups: []` already read. On an
         * underlying-cause database an empty mcd_icd10 is no multiple-cause filter, so it
         * passes the check that rejects a real one there.
         */
        respondWith(FOUR_MEASURE_TABLE);
        const fromEmpty = await runToolContract(queryWonder, {
          database,
          group_by: ['year'],
          [field]: [],
          year_range: { from: 2019, to: 2019 },
        });
        initWonderService();
        const omitted = await runToolContract(queryWonder, {
          database,
          group_by: ['year'],
          year_range: { from: 2019, to: 2019 },
        });

        expect(fromEmpty.isError).toBeFalsy();
        const [emptyXml, omittedXml] = sentRequests();
        expect(sentRequests()).toHaveLength(2);
        expect(emptyXml).toBe(omittedXml);
        expect(structuredOf(fromEmpty).effectiveQuery).toBe(structuredOf(omitted).effectiveQuery);
        expect(textOf(fromEmpty)).toBe(textOf(omitted));
      },
    );

    it.each([
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
