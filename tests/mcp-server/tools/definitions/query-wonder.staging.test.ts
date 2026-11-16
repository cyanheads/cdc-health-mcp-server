/**
 * @fileoverview cdc_query_wonder where the deployment has a DataCanvas: the 100-row default
 * page, the whole table staged at offset 0 beside it, and the SELECT its notice names, read
 * back through cdc_dataframe_query. Runs the real WonderService with only `fetch` faked, over a
 * real DuckDB canvas. The main fixture is a real D76 response grouped by ICD chapter and
 * sub-chapter: 177 rows, four Unreliable crude and four Unreliable age-adjusted rates, and a
 * population past the INTEGER range.
 * @module tests/mcp-server/tools/definitions/query-wonder.staging
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import { CanvasInstance, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import type { WonderResult, WonderRow } from '@/services/wonder/types.js';
import { getWonderService, initWonderService } from '@/services/wonder/wonder-service.js';
import { contentText } from '../../../helpers/contract-text.js';
import { readBack, renderMarkdown } from '../../../helpers/markdown-render.js';
import {
  createStagingCanvas,
  disposeStagingCanvas,
  numberedWonderTable,
  shareTenantStore,
} from '../../../helpers/staging-canvas.js';

const CHAPTER_SUBCHAPTER = readFileSync(
  new URL('../../../fixtures/wonder/d76-icd-chapter-and-subchapter.response.xml', import.meta.url),
  'utf8',
);
const GROUPING = ['icd_chapter', 'icd_subchapter'] as const;
const TABLE_ROWS = 177;
const STAGED_NAME = /^wonder_[a-z0-9]{10}$/;

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Structured = Record<string, unknown> & {
  rows: WonderRow[];
  stagedTable?: string;
  notice?: string;
  caveats: string[];
  messages: string[];
};
const structured = (result: Result) => result.structuredContent as Structured;

/** One cdc_query_wonder call against a fresh service, so no earlier call's gap holds it back. */
async function call(input: Record<string, unknown> = {}, body = CHAPTER_SUBCHAPTER) {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
  return runToolContract(queryWonder, { group_by: [...GROUPING], ...input });
}

/** The whole table the service parses from `body`, to compare pages and staged rows against. */
async function wholeTable(body = CHAPTER_SUBCHAPTER, groupBy = [...GROUPING]) {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
  return getWonderService().query({ database: 'underlying_1999_2020', groupBy, sex: 'all' });
}

/** cdc_dataframe_query's rows for `sql`, failing the test on an error result. */
async function select(sql: string, limit?: number): Promise<Record<string, unknown>[]> {
  const result = await runToolContract(dataframeQuery, { sql, ...(limit ? { limit } : {}) });
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { rows: Record<string, unknown>[] }).rows;
}

/** Only the columns a parsed row carries — a staged row adds its status columns. */
function inlineColumns(row: Record<string, unknown>, like: WonderRow): WonderRow {
  return Object.fromEntries(Object.keys(like).map((key) => [key, row[key]])) as WonderRow;
}

describe('cdc_query_wonder — staging the whole table on a canvas', () => {
  let canvas: DataCanvas;
  let store: Context;

  beforeAll(() => {
    canvas = createStagingCanvas();
  });

  afterAll(async () => {
    await disposeStagingCanvas(canvas);
  });

  beforeEach(() => {
    initWonderService();
    // Nothing here may reach the live API; every call serves a fixture.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
    store = shareTenantStore(canvas);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Tables on the store's canvas; empty when nothing was ever staged there. */
  async function stagedTables() {
    const instance = await canvas.acquireShared(store, { create: false });
    return instance ? instance.describe() : [];
  }

  it('returns 100 rows and stages all 177 when limit is omitted', async () => {
    const before = Date.now();
    const result = await call();
    const sc = structured(result);
    const whole = await wholeTable();

    expect(result.isError).toBeFalsy();
    expect(sc.rows).toEqual(whole.rows.slice(0, 100));
    expect(sc.rowCount).toBe(100);
    expect(sc.totalCount).toBe(TABLE_ROWS);
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(100);
    expect(sc.cap).toBe(100);
    expect(sc.nextOffset).toBe(100);
    expect(sc.stagedTable).toMatch(STAGED_NAME);
    // The caveats and messages describe the whole table and stay inline.
    expect(sc.caveats).toEqual(whole.caveats);
    expect(sc.messages).toEqual(whole.messages);

    const tables = await stagedTables();
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table?.name).toBe(sc.stagedTable);
    expect(table?.rowCount).toBe(TABLE_ROWS);
    expect(table?.columns).toHaveLength(15);
    // Dropped an hour after the staging unless a query reads it first.
    const expiresAt = Date.parse(table?.expiresAt ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it('names the staged table and the SELECT that continues the page, on both surfaces', async () => {
    const result = await call();
    const sc = structured(result);
    const name = sc.stagedTable as string;
    const opening = `Showing rows 1–100 of 177. The whole table is staged as ${name}: cdc_dataframe_query reads the rows after this page with SELECT * FROM ${name} LIMIT 100 OFFSET 100, in CDC's row order, and answers any other SELECT over it without another WONDER request; calling again with offset=100 re-runs the WONDER query.`;

    expect(sc.notice?.startsWith(opening)).toBe(true);
    const shown = readBack(renderMarkdown(contentText(result)));
    expect(shown).toContain(opening);
    expect(shown).toContain(`Whole table staged for SQL as ${name} — every row`);
  });

  it("reads rows 100–176 in CDC's order through the SELECT the notice names", async () => {
    const sc = structured(await call());
    const continuation = sc.notice?.match(
      /SELECT \* FROM wonder_[a-z0-9]{10} LIMIT 100 OFFSET 100/,
    );
    expect(continuation).not.toBeNull();
    const whole = await wholeTable();

    const rows = await select(continuation?.[0] as string);
    expect(rows).toHaveLength(TABLE_ROWS - 100);
    rows.forEach((row, i) => {
      const expected = whole.rows[100 + i] as WonderRow;
      expect(inlineColumns(row, expected)).toEqual(expected);
    });
  });

  it("sets a status column to CDC's token on exactly the rows cellNotes flag", async () => {
    const name = structured(await call()).stagedTable as string;
    const whole = await wholeTable();
    const flagged = whole.cellNotes
      .filter((note) => note.column === 'age_adjusted_rate')
      .map((note) => whole.rows[note.row]?.cause_code);
    expect(flagged).toHaveLength(4);

    const rows = await select(
      `SELECT cause_code, age_adjusted_rate, age_adjusted_rate_status FROM ${name} WHERE age_adjusted_rate_status IS NOT NULL`,
    );
    expect(rows.map((row) => row.cause_code)).toEqual(flagged);
    for (const row of rows) {
      expect(row.age_adjusted_rate_status).toBe('Unreliable');
      expect(row.age_adjusted_rate).toBeNull();
    }
  });

  it('answers SELECT max(population) with the JSON number past the INTEGER range', async () => {
    const name = structured(await call()).stagedTable as string;
    expect(await select(`SELECT max(population) AS p FROM ${name}`)).toEqual([{ p: 6746356647 }]);
  });

  it('continues in stored order at offsets across a 5,000-row table', async () => {
    const body = numberedWonderTable(5000);
    const sc = structured(await call({ group_by: ['year'] }, body));
    expect(sc.totalCount).toBe(5000);
    const name = sc.stagedTable as string;

    for (const offset of [100, 2000, 3001, 4900]) {
      const rows = await select(`SELECT deaths FROM ${name} LIMIT 100 OFFSET ${offset}`);
      expect(rows.map((row) => row.deaths)).toEqual(
        Array.from({ length: 100 }, (_, i) => offset + i),
      );
    }
  });

  it("names a continuation of cdc_dataframe_query's 100-row default page when limit is larger", async () => {
    const sc = structured(
      await call({ group_by: ['year'], limit: 500 }, numberedWonderTable(5000)),
    );
    const name = sc.stagedTable as string;
    const continuation = `SELECT * FROM ${name} LIMIT 100 OFFSET 500`;

    expect(sc.rowCount).toBe(500);
    expect(name).toMatch(STAGED_NAME);
    expect(sc.notice).toContain(
      `cdc_dataframe_query reads the rows after this page with ${continuation},`,
    );
    expect((await select(continuation)).map((row) => row.deaths)).toEqual(
      Array.from({ length: 100 }, (_, i) => 500 + i),
    );
  });

  it('keeps the 100-row default at a later offset and stages nothing there', async () => {
    const sc = structured(await call({ offset: 50 }));

    expect(sc.rowCount).toBe(100);
    expect(sc.cap).toBe(100);
    expect(sc.nextOffset).toBe(150);
    expect(sc.stagedTable).toBeUndefined();
    expect(sc.notice).toContain('Call again with offset=150 for the next page');
    expect(sc.notice).not.toContain('staged');
    expect(await stagedTables()).toEqual([]);
  });

  it.each([
    ['a limit that reaches the end', { limit: 200 }, TABLE_ROWS],
    ['an offset whose page reaches the end', { offset: 100 }, TABLE_ROWS - 100],
  ])('stages nothing for %s', async (_label, input, rowCount) => {
    const sc = structured(await call(input));

    expect(sc.rowCount).toBe(rowCount);
    expect(sc.truncated).toBeUndefined();
    expect(sc.stagedTable).toBeUndefined();
    expect(await stagedTables()).toEqual([]);
  });

  it('stages nothing without a canvas and returns the rest of the table', async () => {
    setCanvas(undefined);
    try {
      const result = await call();
      const sc = structured(result);

      expect(sc.rowCount).toBe(TABLE_ROWS);
      expect(sc.truncated).toBeUndefined();
      expect(sc).not.toHaveProperty('stagedTable');
      expect(contentText(result)).not.toContain('staged');
    } finally {
      setCanvas(canvas);
    }
  });

  it('puts both of two concurrent first stagings on one canvas', async () => {
    // A store of its own tenant in place of the default one, so no earlier canvas is counted.
    vi.restoreAllMocks();
    const tenant = shareTenantStore(canvas, 'concurrent');
    const parsed = await wholeTable();
    vi.spyOn(getWonderService(), 'query').mockResolvedValue(parsed);
    const context = { context: { tenantId: 'concurrent' } };

    const results = await Promise.all([
      runToolContract(queryWonder, { group_by: [...GROUPING] }, context),
      runToolContract(queryWonder, { group_by: [...GROUPING] }, context),
    ]);
    const names = results.map((result) => structured(result).stagedTable);
    expect(results.map((result) => result.isError ?? false)).toEqual([false, false]);
    expect(names[0]).toMatch(STAGED_NAME);
    expect(names[1]).toMatch(STAGED_NAME);
    expect(names[0]).not.toBe(names[1]);

    expect(canvas.countForTenant(tenant)).toBe(1);
    const instance = await canvas.acquireShared(tenant, { create: false });
    const tables = (await instance?.describe())?.map((table) => table.name).sort();
    expect(tables).toEqual([...names].sort());
  });

  it('fails staging_failed, naming the row count, when the canvas cannot take the table', async () => {
    // One canvas per tenant, already held: staging has to mint one and cannot.
    const full = createStagingCanvas({ CANVAS_MAX_CANVASES_PER_TENANT: '1' });
    try {
      await full.acquire(undefined, createMockContext({ tenantId: 'full' }));
      initWonderService();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(CHAPTER_SUBCHAPTER, { status: 200 }),
      );
      const refused = await runToolContract(
        queryWonder,
        { group_by: [...GROUPING] },
        { context: { tenantId: 'full' } },
      );
      const error = (
        refused.structuredContent as {
          error: { code: number; message: string; data: Record<string, unknown> };
        }
      ).error;

      expect(refused.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data.reason).toBe('staging_failed');
      expect(error.data.totalCount).toBe(TABLE_ROWS);
      expect(error.data.retryable).toBe(true);
      expect(error.message).toBe(
        'WONDER returned the 177-row table, but it could not be staged for SQL beside this page.',
      );
      expect(error.data.recovery).toEqual({
        hint: 'Retry the same call, which runs the WONDER query again and stages the table afresh, or pass a limit as large as the table (up to 10,000) to take every row inline with nothing to stage.',
      });
    } finally {
      await disposeStagingCanvas(full);
      setCanvas(canvas);
    }
  });

  it("rejects as cancelled when the call is cancelled before the tenant's canvas is minted", async () => {
    const parsed: WonderResult = await wholeTable();
    const controller = new AbortController();
    const cancellation = new Error('The caller went away while the table staged.');
    // WONDER answers, then the caller gives up before the table is staged.
    vi.spyOn(getWonderService(), 'query').mockImplementation(async () => {
      controller.abort(cancellation);
      return parsed;
    });

    const result = await runToolContract(
      queryWonder,
      { group_by: [...GROUPING] },
      { context: { signal: controller.signal } },
    );
    const error = (result.structuredContent as { error: { code: number; message: string } }).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    /**
     * Once the signal fires, every throw settles as RequestCancelled with its data dropped, so
     * only the message tells the caller's own cancellation from a staging_failed wrapped around it.
     */
    expect(error.message).toBe(cancellation.message);
    expect(contentText(result)).not.toContain('could not be staged');
    expect(await stagedTables()).toEqual([]);
  });

  it('rejects as cancelled and stages nothing when the call is cancelled as its table registers on a live canvas', async () => {
    const first = structured(await call()).stagedTable;
    expect(first).toMatch(STAGED_NAME);
    const controller = new AbortController();
    const cancellation = new Error('The caller went away while the table staged.');
    // The canvas is found and has room; the caller gives up as the table starts to register.
    const registerTable = CanvasInstance.prototype.registerTable;
    vi.spyOn(CanvasInstance.prototype, 'registerTable').mockImplementation(function (
      this: CanvasInstance,
      ...args: Parameters<CanvasInstance['registerTable']>
    ) {
      controller.abort(cancellation);
      return registerTable.apply(this, args);
    });
    initWonderService();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(CHAPTER_SUBCHAPTER, { status: 200 }),
    );

    const result = await runToolContract(
      queryWonder,
      { group_by: [...GROUPING] },
      { context: { signal: controller.signal } },
    );
    const error = (result.structuredContent as { error: { code: number; message: string } }).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.message).toBe(cancellation.message);
    expect((await stagedTables()).map((table) => table.name)).toEqual([first]);
  });
});
