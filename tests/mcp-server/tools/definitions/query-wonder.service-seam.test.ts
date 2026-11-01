/**
 * @fileoverview cdc_query_wonder run end to end against the real WonderService, with only
 * `fetch` faked: link rendering in both response surfaces, the request lane under concurrent
 * tool calls, captured empty responses that differ in which rows CDC hid, captured responses
 * carrying confidence intervals, captured provisional responses and their reporting-lag
 * notices (a month grouping's partial month among them), and a request that never answers.
 * @module tests/mcp-server/tools/definitions/query-wonder.service-seam
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { WONDER_DATABASE_SPECS } from '@/services/wonder/types.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';
import { contentText } from '../../../helpers/contract-text.js';

/** A real D158 response (race × age group, cause C00, 2024), captured from WONDER unchanged. */
const D158_RESPONSE = readFileSync(
  new URL('../../../fixtures/wonder/d158-race-age-c00-2024.response.xml', import.meta.url),
  'utf8',
);

const OK_TABLE = `<results><data-table>
  <r><c l="1999"/><c v="2,391,399"/><c v="279,040,168"/><c v="857.0"/><c v="875.6"/></r>
</data-table></results>`;

/** The interval WONDER needs between a response and the next request, written out. */
const MIN_INTERVAL_MS = 16_000;

const CONFIDENCE_LINK =
  '[More information.](https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Confidence-Intervals)';
const PRIVACY_LINK = '[More Information.](https://wonder.cdc.gov/wonder/help/faq.html#Privacy)';

function textOf(blocks: ReturnType<NonNullable<typeof queryWonder.format>>): string {
  return (blocks[0] as { type: 'text'; text: string }).text;
}

describe('cdc_query_wonder over the real service', () => {
  beforeEach(() => {
    initWonderService();
    // Nothing here may reach the live API; each test installs its own fake over this guard.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps caveat and message links in structuredContent and in content[]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(D158_RESPONSE, { status: 200 }));
    const ctx = createMockContext({ errors: queryWonder.errors });
    const input = queryWonder.input.parse({
      database: 'underlying_2018_2024',
      group_by: ['race', 'age_group'],
      cause_icd10: 'C00',
      year_range: { from: 2024, to: 2024 },
    });

    const result = await queryWonder.handler(input, ctx);
    expect(result.rowCount).toBe(4);
    expect(result.caveats).toContain(
      `The method used to calculate 95% confidence intervals is documented here: ${CONFIDENCE_LINK}`,
    );
    expect(result.messages[0]).toBe(
      `Totals are not available for these results due to suppression constraints. ${PRIVACY_LINK}`,
    );

    const text = textOf(queryWonder.format!(result));
    // Rendered as list items, unescaped, so a Markdown client shows a working link.
    expect(text).toContain(
      `- The method used to calculate 95% confidence intervals is documented here: ${CONFIDENCE_LINK}`,
    );
    expect(text).toContain(
      `- Totals are not available for these results due to suppression constraints. ${PRIVACY_LINK}`,
    );
    expect(text).toContain(
      '(https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Assurance%20of%20Confidentiality)',
    );
    expect(text).not.toMatch(/onclick|setfocus|<a\b/);
  });

  it('runs two concurrent tool calls one after another, spaced from the first response', async () => {
    vi.useFakeTimers();
    const RESPONSE_MS = 1_500;
    const requestedAt: number[] = [];
    const respondedAt: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      requestedAt.push(Date.now());
      return new Promise((resolve) => {
        setTimeout(() => {
          respondedAt.push(Date.now());
          resolve(new Response(OK_TABLE, { status: 200 }));
        }, RESPONSE_MS);
      });
    });

    const calls = [
      queryWonder.handler(
        queryWonder.input.parse({ group_by: ['year'] }),
        createMockContext({ errors: queryWonder.errors }),
      ),
      queryWonder.handler(
        queryWonder.input.parse({ group_by: ['year'] }),
        createMockContext({ errors: queryWonder.errors }),
      ),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2 * RESPONSE_MS + MIN_INTERVAL_MS);
    const results = await Promise.all(calls);
    expect(results.map((r) => r.rowCount)).toEqual([1, 1]);
    expect(requestedAt).toHaveLength(2);
    expect(requestedAt[1]! - respondedAt[0]!).toBe(MIN_INTERVAL_MS);
  });

  describe('captured empty responses replayed through the handler', () => {
    /**
     * Three live WONDER responses, each an empty table, that differ only in which hidden-row
     * messages CDC sent: zero-death rows, suppressed-death rows, or both. The wording the caller
     * reads must follow the message, so a true zero is never sent chasing suppression.
     */
    const ZERO_HIDDEN =
      'Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.';
    const SUPPRESSED_HIDDEN =
      'Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.';
    const fixture = (name: string) =>
      readFileSync(new URL(`../../../fixtures/wonder/${name}`, import.meta.url), 'utf8');

    it.each([
      {
        label: 'zero-death rows hidden (D76, C61, female, 2019)',
        file: 'd76-c61-female-2019-zero-rows-hidden.response.xml',
        input: { cause_icd10: 'C61', sex: 'female', year_range: { from: 2019, to: 2019 } },
        messages: [ZERO_HIDDEN],
        noDeaths: true,
      },
      {
        label: 'suppressed-death rows hidden (D158, A82, 2021)',
        file: 'd158-a82-2021-suppressed-rows-hidden.response.xml',
        input: {
          database: 'underlying_2018_2024',
          cause_icd10: 'A82',
          year_range: { from: 2021, to: 2021 },
        },
        messages: [
          `Totals are not available for these results due to suppression constraints. ${PRIVACY_LINK}`,
          SUPPRESSED_HIDDEN,
        ],
        noDeaths: false,
      },
      {
        label: 'both kinds hidden (D158, A82, 2018–2024)',
        file: 'd158-a82-2018-2024-both-hidden.response.xml',
        input: {
          database: 'underlying_2018_2024',
          cause_icd10: 'A82',
          year_range: { from: 2018, to: 2024 },
        },
        messages: [ZERO_HIDDEN, SUPPRESSED_HIDDEN],
        noDeaths: false,
      },
    ] as const)('replays $label', async ({ file, input, messages, noDeaths }) => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(fixture(file), { status: 200 }));
      const result = await runToolContract(queryWonder, { group_by: ['year'], ...input });

      expect(result.isError).toBeFalsy();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const sc = result.structuredContent as {
        rows: unknown[];
        messages: string[];
        notice: string;
      };
      expect(sc.rows).toEqual([]);
      expect(sc.messages).toEqual(messages);
      const text = contentText(result);
      for (const message of messages) expect(text).toContain(message);

      if (noDeaths) {
        expect(sc.notice).toContain('CDC recorded no deaths for this combination');
        expect(sc.notice).toContain('deaths summed from rows are complete');
        expect(sc.notice).not.toMatch(/Widen|partial|not evidence that nothing matched/);
        expect(text).toContain('CDC recorded no deaths for this combination');
      } else {
        expect(sc.notice).toContain('not evidence that nothing matched');
        expect(sc.notice).toContain('Widen the query');
        expect(sc.notice).toContain(
          'treat counts, rankings, and completeness claims drawn from rows as partial',
        );
        expect(sc.notice).not.toMatch(/recorded no deaths|summed from rows are complete/);
      }
    });
  });

  describe('captured responses that carry confidence intervals', () => {
    const fixture = (name: string) =>
      readFileSync(new URL(`../../../fixtures/wonder/${name}`, import.meta.url), 'utf8');
    const sentXml = (spy: MockInstance<typeof fetch>) => {
      const body = spy.mock.calls[0]?.[1]?.body;
      if (!(body instanceof URLSearchParams)) throw new Error('expected a form-encoded body');
      return body.get('request_xml') ?? '';
    };

    it('returns both rates’ intervals from D77, asked for on the wire', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(fixture('d77-2019-intervals.response.xml')));
      const result = await runToolContract(queryWonder, {
        database: 'multiple_1999_2020',
        group_by: ['year'],
        year_range: { from: 2019, to: 2019 },
      });

      expect(result.isError).toBeFalsy();
      const xml = sentXml(spy);
      expect(xml).toContain('<parameter><name>M_32</name><value>D77.M32</value></parameter>');
      expect(xml).toContain('<parameter><name>O_aar_CI</name><value>true</value></parameter>');
      expect((result.structuredContent as { rows: unknown[] }).rows).toEqual([
        {
          year: '2019',
          deaths: 2854838,
          population: 328239523,
          crude_rate: 869.7,
          crude_rate_lower: 868.7,
          crude_rate_upper: 870.8,
          age_adjusted_rate: 715.2,
          age_adjusted_rate_lower: 714.4,
          age_adjusted_rate_upper: 716.1,
        },
      ]);
      const text = contentText(result);
      expect(text).toContain(
        '| year | deaths | population | crude_rate | crude_rate_lower | crude_rate_upper | age_adjusted_rate | age_adjusted_rate_lower | age_adjusted_rate_upper |',
      );
      expect(text).toContain(
        '| 2019 | 2854838 | 328239523 | 869.7 | 868.7 | 870.8 | 715.2 | 714.4 | 716.1 |',
      );
    });

    it('keeps an Unreliable rate’s interval and leaves a Not Applicable rate’s bounds blank', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(fixture('d76-x40-x49-year-age-1999-2001-intervals.response.xml')),
        );
      const result = await runToolContract(queryWonder, {
        group_by: ['year', 'age_group'],
        cause_icd10: 'X40-X49',
        year_range: { from: 1999, to: 2001 },
      });

      expect(result.isError).toBeFalsy();
      const xml = sentXml(spy);
      expect(xml).toContain('<parameter><name>M_32</name><value>D76.M32</value></parameter>');
      // Age is the grouping axis, so no age-adjusted rate is computed and no interval asked for.
      expect(xml).not.toContain('O_aar_CI');
      const sc = result.structuredContent as {
        rows: Record<string, unknown>[];
        cellNotes: { row: number; column: string; token: string }[];
      };
      expect(sc.rows).toHaveLength(35);
      expect(sc.rows[0]).toMatchObject({
        crude_rate: null,
        crude_rate_lower: 0.2,
        crude_rate_upper: 0.6,
      });
      expect(sc.rows[11]).toMatchObject({
        age_group: 'Not Stated',
        crude_rate: null,
        crude_rate_lower: null,
        crude_rate_upper: null,
      });
      expect(sc.rows.every((row) => !('age_adjusted_rate_lower' in row))).toBe(true);
      expect(sc.cellNotes[0]).toEqual({ row: 0, column: 'crude_rate', token: 'Unreliable' });

      const text = contentText(result);
      expect(text).toContain('| 1999 | < 1 year | 12 | 3795762 | Unreliable | 0.2 | 0.6 |');
      expect(text).toContain('| 1999 | Not Stated | 12 | Not Applicable | Not Applicable |  |  |');
    });
  });

  describe('captured provisional responses and the reporting lag', () => {
    /**
     * Three live D176 responses drawn with data through October 17, 2026: every cause for
     * 2025–2026, the overdose code set for the same years, and the withheld-cause marker across
     * every year. Their rows read as complete; the notice is what says they are not.
     */
    const fixture = (name: string) =>
      readFileSync(new URL(`../../../fixtures/wonder/${name}`, import.meta.url), 'utf8');
    const OVERDOSE = [
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
    const PARTIAL_2026 =
      "The provisional database holds 2026 only through October 17, 2026: deaths for 2026 cover part of the year while its population is the full-year estimate, so counts and rates that include 2026 read low, and neither compares with a finished year's.";
    const LAG_AFTER_MAY_2 =
      'CDC withholds the cause of external-cause (V01-Y89), sudden-death (R95, R96) and drug-poisoning (T36-T50) deaths after May 2, 2026 — the 24 weeks before October 17, 2026 — counting them under "999--999" until their cause is released, so the cause filter here misses them and its counts and rates for any period after May 2, 2026 run low. Query cause_icd10 "999--999" on this database for the count withheld across all three: it spans every withheld cause at once, so it bounds what any one filter or cause row is missing and is never added to that filter\'s or row\'s count.';

    async function replay(file: string, input: Record<string, unknown>) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fixture(file)));
      const result = await runToolContract(queryWonder, { database: 'provisional', ...input });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { rows: Record<string, unknown>[]; notice?: string };
      const text = contentText(result);
      return { rows: sc.rows, notice: sc.notice ?? '', text };
    }

    it('names the partial year on an all-cause query that includes it', async () => {
      const { rows, notice, text } = await replay('d176-2025-2026-partial-year.response.xml', {
        year_range: { from: 2025, to: 2026 },
      });
      expect(rows.map((r) => [r.year, r.deaths, r.population])).toEqual([
        ['2025 (provisional)', 3096843, 340110988],
        ['2026 (provisional and partial)', 2373108, 340110988],
      ]);
      expect(notice).toBe(PARTIAL_2026);
      expect(text).toContain(PARTIAL_2026);
      // No cause filter: CDC counts the withheld deaths in all-cause totals.
      expect(notice).not.toContain('999--999');
    });

    it('adds the withheld-cause cutoff when the cause filter reaches withheld causes', async () => {
      const { rows, notice, text } = await replay('d176-overdose-2025-2026-lag.response.xml', {
        cause_icd10: OVERDOSE,
        year_range: { from: 2025, to: 2026 },
      });
      expect(rows.map((r) => [r.year, r.deaths])).toEqual([
        ['2025 (provisional)', 69391],
        ['2026 (provisional and partial)', 20062],
      ]);
      expect(notice).toBe(`${PARTIAL_2026} ${LAG_AFTER_MAY_2}`);
      expect(text).toContain(PARTIAL_2026);
      expect(text).toContain(LAG_AFTER_MAY_2);
    });

    describe('a month grouping', () => {
      /** Data through October 17, 2026: October holds 17 days' deaths beside September's 30. */
      const MONTHS = fixture('d176-month-2026.response.xml');
      const PARTIAL_OCTOBER =
        " October 2026, the month that date falls in, is itself partial, so its deaths read low beside a full month's.";

      async function replayMonths(body: string, to = 2026) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
        const result = await runToolContract(queryWonder, {
          database: 'provisional',
          group_by: ['month'],
          year_range: { from: 2026, to },
        });
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as {
          rows: Record<string, unknown>[];
          notice: string;
        };
        return { rows: sc.rows, notice: sc.notice, text: contentText(result) };
      }

      it('names the month the data-through date falls in as partial', async () => {
        const { rows, notice, text } = await replayMonths(MONTHS);
        expect(rows.slice(-2).map((r) => [r.month, r.deaths])).toEqual([
          ['Sep., 2026 (provisional and partial)', 234461],
          ['Oct., 2026 (provisional and partial)', 105025],
        ]);
        expect(notice.endsWith(`${PARTIAL_2026}${PARTIAL_OCTOBER}`)).toBe(true);
        expect(text).toContain(`${PARTIAL_2026}${PARTIAL_OCTOBER}`);
      });

      it('keeps the undated wording when the response names no data-through date', async () => {
        /** Undated, the partial year is the database's last year: the current one. */
        const CURRENT_YEAR = WONDER_DATABASE_SPECS.provisional.lastYear;
        const undated = MONTHS.replace(/ vintage="[^"]*"/, '');
        expect(undated).not.toBe(MONTHS);
        const { notice } = await replayMonths(undated, CURRENT_YEAR);
        expect(
          notice.endsWith(
            `The provisional database holds ${CURRENT_YEAR}, the current year, only through its latest weekly update: deaths for ${CURRENT_YEAR} cover part of the year while its population is the full-year estimate, so counts and rates that include ${CURRENT_YEAR} read low, and neither compares with a finished year's.`,
          ),
        ).toBe(true);
        expect(notice).not.toContain('is itself partial');
      });
    });

    it('names the partial year, not the lag, on the withheld-cause count itself', async () => {
      const { rows, notice, text } = await replay('d176-withheld-cause-all-years.response.xml', {
        cause_icd10: '999--999',
      });
      expect(rows.map((r) => [r.year, r.deaths])).toEqual([
        ['2026 (provisional and partial)', 96700],
      ]);
      // The hidden-row clause reads first; what the database means for the figures reads last.
      expect(notice.indexOf('CDC withheld whole rows')).toBe(0);
      expect(notice.endsWith(PARTIAL_2026)).toBe(true);
      expect(notice).not.toContain('CDC withholds the cause');
      expect(text).toContain(PARTIAL_2026);
    });
  });

  describe('captured cause, origin and month responses', () => {
    const fixture = (name: string) =>
      readFileSync(new URL(`../../../fixtures/wonder/${name}`, import.meta.url), 'utf8');

    async function replay(file: string, input: Record<string, unknown>) {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fixture(file)));
      const result = await runToolContract(queryWonder, input);
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        rows: Record<string, unknown>[];
        notice?: string;
        cellNotes: { row: number; column: string; token: string }[];
      };
      const text = contentText(result);
      const body = spy.mock.calls[0]?.[1]?.body;
      const xml = body instanceof URLSearchParams ? (body.get('request_xml') ?? '') : '';
      return { sc, notice: sc.notice ?? '', text, xml };
    }

    it('returns ICD chapters with a cause_code that chains into cause_icd10, on both surfaces', async () => {
      const { sc, text, xml } = await replay('d76-icd-chapter-2019.response.xml', {
        group_by: ['icd_chapter'],
        year_range: { from: 2019, to: 2019 },
      });
      expect(xml).toContain('<parameter><name>B_1</name><value>D76.V2-level1</value></parameter>');
      expect(sc.rows).toHaveLength(20);
      expect(sc.rows[1]).toMatchObject({
        icd_chapter: 'Neoplasms',
        cause_code: 'C00-D48',
        deaths: 615191,
      });
      expect(text).toContain(
        '| icd_chapter | cause_code | deaths | population | crude_rate | crude_rate_lower | crude_rate_upper | age_adjusted_rate | age_adjusted_rate_lower | age_adjusted_rate_upper |',
      );
      expect(text).toContain(
        '| Neoplasms | C00-D48 | 615191 | 328239523 | 187.4 | 187 | 187.9 | 150 | 149.6 | 150.4 |',
      );
      // The code is the form cause_icd10 takes, so the next call can filter on it.
      expect(queryWonder.input.safeParse({ cause_icd10: sc.rows[1]?.cause_code }).success).toBe(
        true,
      );
    });

    it('says the 113-cause rows nest, before naming the twin database, on D77', async () => {
      const { sc, notice, text } = await replay('d77-cause-113-2019.response.xml', {
        database: 'multiple_1999_2020',
        group_by: ['cause_113'],
        year_range: { from: 2019, to: 2019 },
      });
      expect(sc.rows).toHaveLength(131);
      expect(sc.rows.slice(2, 5).map((row) => [row.cause_113, row.cause_level])).toEqual([
        ['#Tuberculosis (A16-A19)', 1],
        ['Respiratory tuberculosis (A16)', 2],
        ['Other tuberculosis (A17-A19)', 2],
      ]);
      const nesting = notice.indexOf('Rows grouped by cause_113 nest');
      expect(nesting).toBeGreaterThan(notice.indexOf('CDC withheld whole rows'));
      expect(notice.indexOf('D77 records every cause listed')).toBeGreaterThan(nesting);
      expect(text).toContain('| Respiratory tuberculosis (A16) | 2 | 346 |');
    });

    it('covers the provisional chapter grouping inside the lag window, withheld-cause row and all', async () => {
      const { sc, notice, text } = await replay('d176-icd-chapter-2026-lag.response.xml', {
        database: 'provisional',
        group_by: ['icd_chapter'],
        year_range: { from: 2026, to: 2026 },
      });
      expect(sc.rows.map((row) => row.cause_code).slice(-2)).toEqual(['V01-Y89', '999--999']);
      const partial = notice.indexOf(
        'The provisional database holds 2026 only through October 17, 2026',
      );
      const lag = notice.indexOf(
        'so the icd_chapter rows for those causes miss them and their counts and rates for any period after May 2, 2026 run low',
      );
      expect(partial).toBe(0);
      expect(lag).toBeGreaterThan(partial);
      expect(text).toContain('| 999--999 | 96700 |');
    });

    it('returns months as deaths only, tallying the Not Applicable cells', async () => {
      const { sc, notice, xml } = await replay('d76-year-month-2019.response.xml', {
        group_by: ['year', 'month'],
        year_range: { from: 2019, to: 2019 },
      });
      expect(xml).toContain('<parameter><name>B_2</name><value>D76.V1-level2</value></parameter>');
      expect(sc.rows).toHaveLength(12);
      expect(sc.rows[0]).toMatchObject({ year: '2019', month: 'Jan., 2019', deaths: 257649 });
      expect(sc.cellNotes).toHaveLength(36);
      expect(notice).toContain('Not Applicable (36 cells)');
    });
  });

  it('returns a request WONDER never answers as a retryable upstream_error after 20 s', async () => {
    /**
     * The deadline lives in the service; this proves the tool hands its expiry back under the
     * declared reason, on both surfaces, rather than as a cancellation or a framework Timeout.
     */
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const pending = runToolContract(queryWonder, { group_by: ['year'] });
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await pending;

    expect(outcome.isError).toBe(true);
    const error = (outcome.structuredContent as { error: { code: number; data: object } }).error;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'upstream_error',
      recovery: { hint: queryWonder.errors?.find((e) => e.reason === 'upstream_error')?.recovery },
    });
    const text = contentText(outcome);
    expect(text).toContain('CDC WONDER did not answer within 20 seconds');
  });
});
