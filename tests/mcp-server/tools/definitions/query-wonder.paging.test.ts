/**
 * @fileoverview cdc_query_wonder's paging and its 10,000-row per-call ceiling, measured on the
 * complete tool result (`structuredContent` and `content[]` together) through the real
 * WonderService with only `fetch` faked. The main fixture is a real D76 response grouped by
 * year, age group, sex and race: 2,014 rows, 156 `Not Applicable` cell notes, seven linked
 * caveats, three messages. The ceiling is exercised on a synthetic table one row past it.
 * @module tests/mcp-server/tools/definitions/query-wonder.paging
 */

import { readFileSync } from 'node:fs';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import type { WonderCellNote } from '@/services/wonder/types.js';
import { getWonderService, initWonderService } from '@/services/wonder/wonder-service.js';
import { contentText as text } from '../../../helpers/contract-text.js';

/** Most rows one call returns, written out so the tests pin the number rather than echo it. */
const ROW_CEILING = 10_000;
const FOUR_DIMENSIONS = ['year', 'age_group', 'sex', 'race'] as const;
const TABLE_ROWS = 2014;

/** A real D76 response for `group_by: ["year","age_group","sex","race"]`, all years, unchanged. */
const D76_FOUR_DIMENSIONS = readFileSync(
  new URL('../../../fixtures/wonder/d76-year-age-sex-race.response.xml', import.meta.url),
  'utf8',
);

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Row = Record<string, string | number | null>;
type Structured = Record<string, unknown> & {
  rows: Row[];
  rowCount: number;
  caveats: string[];
  messages: string[];
  cellNotes: WonderCellNote[];
  notice?: string;
};

const structured = (result: Result) => result.structuredContent as Structured;

/**
 * One call against a fresh service, so the 16-second request gap a previous call stamped does
 * not hold this one back.
 */
async function call(input: Record<string, unknown>, body = D76_FOUR_DIMENSIONS): Promise<Result> {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
  return runToolContract(queryWonder, { group_by: [...FOUR_DIMENSIONS], ...input });
}

/** A D76 table in WONDER's `<data-table>` shape, one `<r>` per entry of `rows`. */
function table(rows: string[]): string {
  return `<page><data-table>${rows.join('')}</data-table></page>`;
}

/** A year-grouped table of `n` rows whose death count is the row's own index. */
function numberedTable(n: number): string {
  return table(
    Array.from(
      { length: n },
      (_, i) =>
        `<r><c l="${1999 + (i % 22)}"/><c v="${i}"/><c v="1,000"/><c v="1.0"/><c v="1.0"/></r>`,
    ),
  );
}

/** One row past the ceiling — the smallest table a call cannot return whole. */
const PAST_CEILING = numberedTable(ROW_CEILING + 1);

describe('cdc_query_wonder — paging and the row ceiling', () => {
  beforeEach(() => {
    initWonderService();
    // Nothing here may reach the live API; every call serves a fixture.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a table under the ceiling', () => {
    it('returns all 2,014 rows of the four-dimension table when limit is omitted', async () => {
      const result = await call({});
      const sc = structured(result);

      expect(sc.rowCount).toBe(TABLE_ROWS);
      expect(sc.rows).toHaveLength(TABLE_ROWS);
      expect(sc.totalCount).toBe(TABLE_ROWS);
      expect(sc.truncated).toBeUndefined();
      expect(sc.shown).toBeUndefined();
      expect(sc.cap).toBeUndefined();
      expect(sc.nextOffset).toBeUndefined();
      expect(sc.notice ?? '').not.toMatch(/Showing rows|offset=/);

      // content[] carries the same table: one line per row, one itemized line per flagged cell.
      const lines = text(result).split('\n');
      expect(lines.filter((l) => /^\| (19|20)\d\d \|/.test(l))).toHaveLength(TABLE_ROWS);
      expect(sc.cellNotes).toHaveLength(156);
      expect(lines.filter((l) => /^- row \d+, `/.test(l))).toHaveLength(156);
    });

    it('pages limit: 100 a hundred rows at a time and ends with the last 14', async () => {
      // The whole parsed table, straight from the service, to compare the walk against.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(D76_FOUR_DIMENSIONS, { status: 200 }),
      );
      const whole = await getWonderService().query({
        database: 'underlying_1999_2020',
        groupBy: [...FOUR_DIMENSIONS],
        sex: 'all',
      });
      expect(whole.rows).toHaveLength(TABLE_ROWS);

      const rows: Row[] = [];
      const notes: WonderCellNote[] = [];
      const pages: Structured[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const sc = structured(await call({ limit: 100, offset }));
        expect(sc.totalCount).toBe(TABLE_ROWS);
        rows.push(...sc.rows);
        // Page-relative notes, lifted back onto the table's numbering.
        notes.push(...sc.cellNotes.map((n) => ({ ...n, row: n.row + (offset as number) })));
        pages.push(sc);
        offset = sc.nextOffset as number | undefined;
      }

      expect(pages).toHaveLength(21);
      for (const [i, page] of pages.slice(0, -1).entries()) {
        expect(page.rowCount).toBe(100);
        expect(page.truncated).toBe(true);
        expect(page.shown).toBe(100);
        expect(page.cap).toBe(100);
        expect(page.nextOffset).toBe(100 * (i + 1));
        expect(page.notice).toContain('or raise limit to pull more per call');
      }
      const last = pages.at(-1) as Structured;
      expect(last.rowCount).toBe(14);
      expect(last.truncated).toBeUndefined();
      expect(last.nextOffset).toBeUndefined();
      expect(last.notice).toContain('Showing rows 2,001–2,014 of 2,014 — the end of the table.');

      expect(rows).toEqual(whole.rows);
      expect(notes).toEqual(whole.cellNotes);
      for (const page of pages) {
        expect(page.caveats).toEqual(whole.caveats);
        expect(page.messages).toEqual(whole.messages);
      }
    });

    it('formats every row count in the page notices and keeps parameter values bare', async () => {
      /**
       * Row counts read as numbers (`2,014`); the values a caller passes back (`offset=1100`,
       * `limit=100`) stay in the form the input takes.
       */
      const middle = structured(await call({ offset: 1000, limit: 100 }));
      expect(middle.notice).toContain(
        'Showing rows 1,001–1,100 of 2,014. Call again with offset=1100',
      );

      const end = structured(await call({ offset: 1900 }));
      expect(end.notice).toContain('Showing rows 1,901–2,014 of 2,014 — the end of the table.');

      const past = structured(await call({ offset: 5000 }));
      expect(past.notice).toContain(
        'offset 5000 is past the end of this table, which holds 2,014 row(s) — the query itself matched. Lower offset below 2,014',
      );
    });

    it.each([5000, 1_000_000])(
      'returns the whole table for limit %j, above both the table and the ceiling',
      async (limit) => {
        /** The ceiling lowers the page size; it never cuts a table shorter than itself. */
        const sc = structured(await call({ limit }));

        expect(sc.rowCount).toBe(TABLE_ROWS);
        expect(sc.truncated).toBeUndefined();
        expect(sc.cap).toBeUndefined();
        expect(sc.nextOffset).toBeUndefined();
        expect(sc.notice ?? '').not.toMatch(/lowered|at most/);
      },
    );

    it('returns a row of any width whole, beside the rest of the table', async () => {
      /** No character budget stands between a wide row and the page. */
      const wide = 'x'.repeat(250_000);
      const body = table([
        `<r><c l="${wide}"/><c v="10"/><c v="1,000"/><c v="1.0"/><c v="1.0"/></r>`,
        '<r><c l="2000"/><c v="20"/><c v="1,000"/><c v="2.0"/><c v="2.0"/></r>',
      ]);
      const result = await call({ group_by: ['year'] }, body);
      const sc = structured(result);

      expect(sc.rowCount).toBe(2);
      expect(sc.rows[0]?.year).toBe(wide);
      expect(sc.truncated).toBeUndefined();
      expect(text(result)).toContain(`| ${wide} |`);
    });

    it('returns an empty page, not an error, for an offset past the end', async () => {
      const result = await call({ offset: TABLE_ROWS });
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.rows).toEqual([]);
      expect(sc.totalCount).toBe(TABLE_ROWS);
      expect(sc.truncated).toBeUndefined();
      expect(sc.nextOffset).toBeUndefined();
      expect(sc.notice).toContain('past the end');
    });

    it('reads an empty table as "no rows matched"', async () => {
      const sc = structured(await call({ group_by: ['year'] }, table([])));

      expect(sc.rows).toEqual([]);
      expect(sc.totalCount).toBe(0);
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toContain('No rows matched');
    });
  });

  describe('a table past the ceiling', () => {
    it('returns 10,000 rows of a 10,001-row table when limit is omitted, naming the ceiling', async () => {
      const result = await call({ group_by: ['year'] }, PAST_CEILING);
      const sc = structured(result);

      expect(sc.totalCount).toBe(ROW_CEILING + 1);
      expect(sc.rowCount).toBe(ROW_CEILING);
      expect(sc.rows.at(-1)?.deaths).toBe(ROW_CEILING - 1);
      expect(sc.truncated).toBe(true);
      expect(sc.shown).toBe(ROW_CEILING);
      expect(sc.cap).toBe(ROW_CEILING);
      expect(sc.nextOffset).toBe(ROW_CEILING);
      expect(sc.notice).toContain(
        'Showing rows 1–10,000 of 10,001. One call returns at most 10,000 rows. Call again with offset=10000 for the next page',
      );
      expect(sc.notice).not.toMatch(/raise limit|lowered/);

      // Both surfaces carry the same page and the same continuation.
      const rendered = text(result);
      expect(rendered.split('\n').filter((l) => /^\| (19|20)\d\d \|/.test(l))).toHaveLength(
        ROW_CEILING,
      );
      expect(rendered).toContain('offset=10000');
    });

    it.each([ROW_CEILING + 1, 1_000_000, Number.MAX_SAFE_INTEGER])(
      'lowers limit %j to the 10,000-row ceiling and says so',
      async (limit) => {
        const result = await call({ group_by: ['year'], limit }, PAST_CEILING);
        const sc = structured(result);

        expect(result.isError).toBeFalsy();
        expect(sc.rowCount).toBe(ROW_CEILING);
        expect(sc.truncated).toBe(true);
        expect(sc.shown).toBe(ROW_CEILING);
        expect(sc.cap).toBe(ROW_CEILING);
        expect(sc.nextOffset).toBe(ROW_CEILING);
        expect(sc.notice).toContain(
          `One call returns at most 10,000 rows, so limit=${limit} was lowered to 10000.`,
        );
        expect(sc.notice).not.toMatch(/raise limit/);
        expect(text(result)).toContain(`limit=${limit} was lowered to 10000`);
      },
    );

    it('treats a limit of exactly 10,000 as the page, without advice to raise it', async () => {
      const sc = structured(await call({ group_by: ['year'], limit: ROW_CEILING }, PAST_CEILING));

      expect(sc.rowCount).toBe(ROW_CEILING);
      expect(sc.cap).toBe(ROW_CEILING);
      expect(sc.nextOffset).toBe(ROW_CEILING);
      expect(sc.notice).toContain('One call returns at most 10,000 rows.');
      expect(sc.notice).not.toMatch(/raise limit|lowered/);
    });

    it('keeps a limit below the ceiling as the page, with advice to raise it', async () => {
      const sc = structured(await call({ group_by: ['year'], limit: 5000 }, PAST_CEILING));

      expect(sc.rowCount).toBe(5000);
      expect(sc.cap).toBe(5000);
      expect(sc.nextOffset).toBe(5000);
      expect(sc.notice).toContain('or raise limit to pull more per call');
      expect(sc.notice).not.toMatch(/at most 10,000|lowered/);
    });

    it('returns the last row from the next offset, ending the table', async () => {
      const sc = structured(await call({ group_by: ['year'], offset: ROW_CEILING }, PAST_CEILING));

      expect(sc.rowCount).toBe(1);
      expect(sc.rows[0]?.deaths).toBe(ROW_CEILING);
      expect(sc.truncated).toBeUndefined();
      expect(sc.nextOffset).toBeUndefined();
      expect(sc.notice).toContain('Showing rows 10,001–10,001 of 10,001 — the end of the table.');
    });

    it('returns a remainder of exactly 10,000 rows whole, with no continuation', async () => {
      const sc = structured(await call({ group_by: ['year'], offset: 1 }, PAST_CEILING));

      expect(sc.rowCount).toBe(ROW_CEILING);
      expect(sc.rows[0]?.deaths).toBe(1);
      expect(sc.truncated).toBeUndefined();
      expect(sc.nextOffset).toBeUndefined();
      expect(sc.notice).toContain('— the end of the table.');
    });
  });

  it('names no character budget on any surface the caller reads', async () => {
    const describedFields = [
      queryWonder.description,
      queryWonder.input.shape.limit.description ?? '',
      queryWonder.input.shape.offset.description ?? '',
      queryWonder.output.shape.rows.description ?? '',
      queryWonder.enrichment?.cap.description ?? '',
      queryWonder.enrichment?.notice.description ?? '',
    ];
    for (const field of describedFields) expect(field).not.toMatch(/budget|character/i);
    expect(queryWonder.input.shape.limit.description).toContain('10,000');
    expect(queryWonder.description).toContain('10,000 rows');

    const sc = structured(await call({ group_by: ['year'] }, PAST_CEILING));
    expect(sc.notice).not.toMatch(/budget|character/i);
  });
});
