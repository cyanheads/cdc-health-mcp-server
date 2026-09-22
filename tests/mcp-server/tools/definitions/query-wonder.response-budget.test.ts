/**
 * @fileoverview cdc_query_wonder's response budget, measured on the complete tool result
 * (`structuredContent` and `content[]` together) through the real WonderService with only
 * `fetch` faked. The main fixture is a real D76 response grouped by year, age group, sex and
 * race: 2,014 rows, 156 `Not Applicable` cell notes, seven linked caveats, three messages.
 * @module tests/mcp-server/tools/definitions/query-wonder.response-budget
 */

import { readFileSync } from 'node:fs';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import type { WonderCellNote } from '@/services/wonder/types.js';
import { getWonderService, initWonderService } from '@/services/wonder/wonder-service.js';

const RESPONSE_BUDGET = 200_000;
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
};

const structured = (result: Result) => result.structuredContent as Structured;
const text = (result: Result) =>
  (result.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n');
const size = (result: Result) => JSON.stringify(result).length;

/**
 * One call against a fresh service, so the 16-second request gap a previous call stamped does
 * not hold this one back.
 */
async function call(input: Record<string, unknown>, body = D76_FOUR_DIMENSIONS): Promise<Result> {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
  return runToolContract(queryWonder, { group_by: [...FOUR_DIMENSIONS], ...input });
}

/** A D76 table of `rows`, each a (year, sex) row, in WONDER's `<data-table>` shape. */
function table(rows: string[]): string {
  return `<page><data-table>${rows.join('')}</data-table></page>`;
}

describe('cdc_query_wonder — response budget', () => {
  beforeEach(() => {
    initWonderService();
    // Nothing here may reach the live API; every call serves a fixture.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pages an explicit small limit exactly as before, naming the limit as the cause', async () => {
    const result = await call({ limit: 100 });
    const sc = structured(result);

    expect(sc.rowCount).toBe(100);
    expect(sc.totalCount).toBe(TABLE_ROWS);
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(100);
    expect(sc.cap).toBe(100);
    expect(sc.nextOffset).toBe(100);
    expect(sc.notice).toContain('Showing rows 1–100 of 2014');
    expect(sc.notice).not.toMatch(/budget/);
    expect(size(result)).toBeLessThan(RESPONSE_BUDGET);
  });

  it('keeps the four-dimension call without a limit inside the budget, on both surfaces', async () => {
    const result = await call({});
    const sc = structured(result);

    expect(size(result)).toBeLessThanOrEqual(RESPONSE_BUDGET);
    expect(sc.rowCount).toBeGreaterThan(0);
    expect(sc.rowCount).toBeLessThan(TABLE_ROWS);
    expect(sc.totalCount).toBe(TABLE_ROWS);
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(sc.rowCount);
    // With no limit the call asked for every row from its offset to the end of the table.
    expect(sc.cap).toBe(TABLE_ROWS);
    expect(sc.nextOffset).toBe(sc.rowCount);
    expect(sc.notice).toMatch(/200,000-character response budget/);
    expect(sc.notice).not.toMatch(/raise limit/);
    expect(sc.notice).toContain(`at ${sc.rowCount} of the 2014 rows left in the table`);

    // content[] carries the same page: one table line per row, one itemized line per note.
    const lines = text(result).split('\n');
    expect(lines.filter((l) => /^\| (19|20)\d\d \|/.test(l))).toHaveLength(sc.rowCount);
    expect(lines.filter((l) => /^- row \d+, `/.test(l))).toHaveLength(sc.cellNotes.length);
  });

  it('uses most of the budget rather than cutting far short of it', async () => {
    const result = await call({});
    expect(size(result)).toBeGreaterThan(RESPONSE_BUDGET * 0.9);
  });

  it('cuts an explicit limit above the budget and names the budget, not the limit', async () => {
    const result = await call({ limit: 5000 });
    const sc = structured(result);

    expect(size(result)).toBeLessThanOrEqual(RESPONSE_BUDGET);
    expect(sc.truncated).toBe(true);
    expect(sc.cap).toBe(5000);
    expect(sc.shown).toBe(sc.rowCount);
    expect(sc.nextOffset).toBe(sc.rowCount);
    expect(sc.notice).toMatch(/200,000-character response budget/);
    expect(sc.notice).toContain(
      `at ${sc.rowCount} of the 2014 rows limit=5000 would have returned`,
    );
  });

  it('walks every row by nextOffset, without gaps or repeats, each page inside the budget', async () => {
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
      const result = await call({ offset });
      const sc = structured(result);
      expect(size(result)).toBeLessThanOrEqual(RESPONSE_BUDGET);
      expect(sc.totalCount).toBe(TABLE_ROWS);
      rows.push(...sc.rows);
      // Page-relative notes, lifted back onto the table's numbering.
      notes.push(...sc.cellNotes.map((n) => ({ ...n, row: n.row + (offset as number) })));
      pages.push(sc);
      offset = sc.nextOffset as number | undefined;
    }

    expect(pages.length).toBeGreaterThan(2);
    expect(rows).toEqual(whole.rows);
    expect(notes).toEqual(whole.cellNotes);
    for (const page of pages) {
      expect(page.caveats).toEqual(whole.caveats);
      expect(page.messages).toEqual(whole.messages);
    }
    // The last page runs to the end of the table and says so.
    const last = pages.at(-1) as Structured;
    expect(last.truncated).toBeUndefined();
    expect(last.nextOffset).toBeUndefined();
    expect(last.notice).toContain('the end of the table');
  });

  it('re-bases the notes on a page that is not the first onto that page', async () => {
    const first = structured(await call({}));
    const second = structured(await call({ offset: first.nextOffset }));

    expect(second.cellNotes.length).toBeGreaterThan(0);
    for (const note of second.cellNotes) {
      expect(note.row).toBeGreaterThanOrEqual(0);
      expect(note.row).toBeLessThan(second.rowCount);
      expect(second.rows[note.row]?.[note.column]).toBeNull();
    }
  });

  it('returns the remainder whole when it fits, with no continuation', async () => {
    const result = await call({ offset: 1900 });
    const sc = structured(result);

    expect(sc.rowCount).toBe(TABLE_ROWS - 1900);
    expect(sc.truncated).toBeUndefined();
    expect(sc.nextOffset).toBeUndefined();
    expect(sc.notice).toContain('the end of the table');
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
    const result = await call({ group_by: ['year'] }, table([]));
    const sc = structured(result);

    expect(sc.rows).toEqual([]);
    expect(sc.totalCount).toBe(0);
    expect(sc.truncated).toBeUndefined();
    expect(sc.notice).toContain('No rows matched');
  });

  it('names the budget on limit and in the description, and no longer promises the whole table', () => {
    const limit = queryWonder.input.shape.limit.description ?? '';
    expect(limit).toContain('200,000-character budget');
    expect(limit).not.toMatch(/whole table/i);
    expect(queryWonder.description).toContain('200,000-character budget');
    expect(queryWonder.description).not.toMatch(/whole table comes back/i);
  });

  it('still returns a first row larger than the whole budget, and points past it', async () => {
    const wide = 'x'.repeat(250_000);
    const body = table([
      `<r><c l="${wide}"/><c v="10"/><c v="1,000"/><c v="1.0"/><c v="1.0"/></r>`,
      '<r><c l="2000"/><c v="20"/><c v="1,000"/><c v="2.0"/><c v="2.0"/></r>',
    ]);
    const result = await call({ group_by: ['year'] }, body);
    const sc = structured(result);

    expect(sc.rowCount).toBe(1);
    expect(sc.rows[0]?.year).toBe(wide);
    expect(sc.totalCount).toBe(2);
    expect(sc.truncated).toBe(true);
    expect(sc.nextOffset).toBe(1);
    expect(sc.notice).toMatch(/200,000-character response budget/);
  });
});
