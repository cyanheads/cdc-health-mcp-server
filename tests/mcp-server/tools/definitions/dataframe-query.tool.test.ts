/**
 * @fileoverview cdc_dataframe_query over a real DuckDB canvas, with tables staged through
 * cdc_query_wonder from WONDER responses served by a faked `fetch`: the row limit and its
 * notices, the 1,000,000-byte reply ceiling, tables that are not staged, the SQL gate, and the
 * table, JSON, and empty renderings of `format()`.
 * @module tests/mcp-server/tools/definitions/dataframe-query.tool
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { DuckDBConnection, DuckDBResultReader } from '@duckdb/node-api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dataframeQuery,
  leadingWord,
} from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import type { WonderGroupBy, WonderRow } from '@/services/wonder/types.js';
import { getWonderService, initWonderService } from '@/services/wonder/wonder-service.js';
import { contentText } from '../../../helpers/contract-text.js';
import { expectLinearDoublings, fill } from '../../../helpers/cpu-cost.js';
import { readBack, renderedCells, renderMarkdown } from '../../../helpers/markdown-render.js';
import {
  createStagingCanvas,
  disposeStagingCanvas,
  numberedWonderTable,
  shareTenantStore,
  stageWonderTable,
} from '../../../helpers/staging-canvas.js';

const CHAPTER_SUBCHAPTER = readFileSync(
  new URL('../../../fixtures/wonder/d76-icd-chapter-and-subchapter.response.xml', import.meta.url),
  'utf8',
);
const GROUPING: WonderGroupBy[] = ['icd_chapter', 'icd_subchapter'];
const TABLE_ROWS = 177;
const STATUS_COLUMNS = [
  'deaths_status',
  'population_status',
  'crude_rate_status',
  'age_adjusted_rate_status',
];

const MISSING_TABLE_HINT =
  'Call cdc_dataframe_describe to list the tables staged now, or call cdc_query_wonder again at offset 0 to stage the table afresh and query the name it returns.';
const TOO_LARGE_HINT =
  'Select fewer or narrower columns, aggregate, or lower limit so the rows returned stay under 1,000,000 bytes, then retry.';
const NOT_A_SELECT_HINT =
  'Send one read-only SELECT over the staged tables; statements other than a SELECT are refused.';
const RESERVED_COLUMN_HINT =
  'Rename the column with AS to any other name, such as AS proto, and retry the SELECT.';
const PAGE_ON = 'Aggregate or filter in the SQL, or add LIMIT and OFFSET to page through the rest.';
const LOWERED = 'limit=5000 was lowered to 1000, the most rows one call returns.';

type Row = Record<string, unknown>;
type Structured = Row & { columns: string[]; rows: Row[]; rowCount: number; notice?: string };
type ToolError = { code: number; message: string; data: Record<string, unknown> };
type Result = Awaited<ReturnType<typeof runToolContract>>;

const structured = (result: Result) => result.structuredContent as Structured;
const failure = (result: Result) => (result.structuredContent as { error: ToolError }).error;

async function query(sql: string, limit?: number): Promise<Result> {
  return runToolContract(dataframeQuery, { sql, ...(limit === undefined ? {} : { limit }) });
}

/** The whole table the service parses from the chapter × sub-chapter response. */
async function wholeTable() {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(CHAPTER_SUBCHAPTER, { status: 200 }),
  );
  return getWonderService().query({
    database: 'underlying_1999_2020',
    groupBy: ['icd_chapter', 'icd_subchapter'],
    sex: 'all',
  });
}

/** Only the columns a parsed row carries — a staged row adds its status columns. */
function inlineColumns(row: Row, like: WonderRow): WonderRow {
  return Object.fromEntries(Object.keys(like).map((key) => [key, row[key]])) as WonderRow;
}

describe('cdc_dataframe_query', () => {
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
    // Nothing here may reach the live API; every staging serves a fixture.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
    store = shareTenantStore(canvas);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('row limit', () => {
    it('returns 100 rows by default, in table order, and says more remain', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      const whole = await wholeTable();

      const result = await query(`SELECT * FROM ${name}`);
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.columns).toEqual([...Object.keys(whole.rows[0] as WonderRow), ...STATUS_COLUMNS]);
      expect(sc.rowCount).toBe(100);
      sc.rows.forEach((row, i) => {
        const expected = whole.rows[i] as WonderRow;
        expect(inlineColumns(row, expected)).toEqual(expected);
      });
      expect(sc.truncated).toBe(true);
      expect(sc.shown).toBe(100);
      expect(sc.cap).toBe(100);
      expect(sc.notice).toBe(`Showing the first 100 rows; more remain. ${PAGE_ON}`);

      const shown = readBack(renderMarkdown(contentText(result)));
      expect(shown).toContain('100 rows');
      expect(shown).toContain(`Showing the first 100 rows; more remain. ${PAGE_ON}`);
    });

    it('marks nothing truncated when the result fills the limit exactly', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const sc = structured(await query(`SELECT * FROM ${name} LIMIT 100`));

      expect(sc.rowCount).toBe(100);
      expect(sc.truncated).toBeUndefined();
      expect(sc.shown).toBeUndefined();
      expect(sc.cap).toBeUndefined();
      expect(sc.notice).toBeUndefined();
    });

    it('lowers a limit above 1,000 to 1,000 and says so beside the rows that remain', async () => {
      const name = await stageWonderTable(numberedWonderTable(5000), ['year']);

      const result = await query(`SELECT deaths FROM ${name}`, 5000);
      const sc = structured(result);

      expect(sc.rows.map((row) => row.deaths)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
      expect(sc.truncated).toBe(true);
      expect(sc.shown).toBe(1000);
      expect(sc.cap).toBe(1000);
      expect(sc.notice).toBe(`Showing the first 1,000 rows; more remain. ${LOWERED} ${PAGE_ON}`);
      expect(readBack(renderMarkdown(contentText(result)))).toContain(LOWERED);
    });

    it('lowers a limit above 1,000 with a notice when every row fits', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(`SELECT * FROM ${name}`, 5000);
      const sc = structured(result);

      expect(sc.rowCount).toBe(TABLE_ROWS);
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toBe(LOWERED);
      expect(readBack(renderMarkdown(contentText(result)))).toContain(LOWERED);
    });

    it('returns SELECT * at limit 1,000 from a table whose rows fit the reply ceiling', async () => {
      const name = await stageWonderTable(numberedWonderTable(5000), ['year']);

      const sc = structured(await query(`SELECT * FROM ${name}`, 1000));

      expect(sc.rowCount).toBe(1000);
      expect(sc.rows.map((row) => row.deaths)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
      expect(sc.truncated).toBe(true);
      expect(sc.cap).toBe(1000);
      expect(sc.notice).toBe(`Showing the first 1,000 rows; more remain. ${PAGE_ON}`);
    });

    it('keeps the columns, values, and order of a SELECT naming columns like the reply measurements', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const sc = structured(
        await query(
          `SELECT deaths, -deaths AS ord, 1000 AS reply_rows, 2000000 AS reply_bytes, 'q' AS q, 'r' AS r FROM ${name} LIMIT 3`,
        ),
      );

      expect(sc.columns).toEqual(['deaths', 'ord', 'reply_rows', 'reply_bytes', 'q', 'r']);
      const deaths = (await wholeTable()).rows.slice(0, 3).map((row) => row.deaths);
      expect(sc.rows).toEqual(
        deaths.map((d) => ({
          deaths: d,
          ord: -(d as number),
          reply_rows: 1000,
          reply_bytes: 2000000,
          q: 'q',
          r: 'r',
        })),
      );
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toBeUndefined();
    });

    it('yields no more than limit rows from the statement', async () => {
      const name = await stageWonderTable(numberedWonderTable(5000), ['year']);
      const read: number[] = [];
      const getRowObjectsJson = DuckDBResultReader.prototype.getRowObjectsJson;
      vi.spyOn(DuckDBResultReader.prototype, 'getRowObjectsJson').mockImplementation(function (
        this: DuckDBResultReader,
      ) {
        const rows = getRowObjectsJson.call(this);
        read.push(rows.length);
        return rows;
      });

      const sc = structured(await query(`SELECT deaths FROM ${name}`, 10));

      expect(sc.rows.map((row) => row.deaths)).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(sc.truncated).toBe(true);
      // The statement's output is the rows the reply carries.
      expect(read.length).toBeGreaterThan(0);
      expect(Math.max(...read)).toBeLessThanOrEqual(10);
    });
  });

  describe('reply ceiling', () => {
    /** The staged rows plus a pad column of `width` characters each. */
    const padded = (name: string, width: number) =>
      `SELECT *, repeat('x', ${width}) AS pad FROM ${name}`;

    it('fails result_too_large past 1,000,000 bytes, naming the measured bytes and the ceiling', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(padded(name, 11_000));
      const error = failure(result);
      const replyBytes = error.data.replyBytes as number;

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('result_too_large');
      expect(error.data.maxReplyBytes).toBe(1_000_000);
      // The JSON size of the first 100 rows, the default limit, measured by a SELECT of its own.
      const [measured] = structured(
        await query(
          `SELECT sum(strlen(CAST(to_json(t) AS VARCHAR)))::DOUBLE AS n FROM (${padded(name, 11_000)} LIMIT 100) AS t`,
        ),
      ).rows;
      expect(replyBytes).toBe(measured?.n);
      expect(error.message).toBe(
        `The rows this SELECT returns at limit 100 measure ${replyBytes.toLocaleString('en-US')} bytes as JSON, past the 1,000,000-byte ceiling on one reply.`,
      );
      expect(error.data.recovery).toEqual({ hint: TOO_LARGE_HINT });
      const text = contentText(result);
      expect(text).toContain('past the 1,000,000-byte ceiling on one reply.');
      expect(text).toContain(`Recovery: ${TOO_LARGE_HINT}`);
    });

    it('returns a reply of exactly 1,000,000 bytes and fails one byte past it', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      // One row {"pad":"…"}: 10 bytes of JSON around the pad.
      const single = (padLength: number) =>
        query(`SELECT repeat('x', ${padLength}) AS pad FROM ${name} LIMIT 1`);

      const atCeiling = structured(await single(999_990));
      expect(atCeiling.rows).toEqual([{ pad: 'x'.repeat(999_990) }]);

      const past = failure(await single(999_991));
      expect(past.data.reason).toBe('result_too_large');
      expect(past.data.replyBytes).toBe(1_000_001);
    });

    it('returns both rows of a two-row reply of exactly 1,000,000 bytes and fails two bytes past it', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      // Two rows {"pad":"…"}: 10 bytes of JSON around each pad.
      const pair = (padLength: number) =>
        query(`SELECT repeat('x', ${padLength}) AS pad FROM ${name} LIMIT 2`);

      const atCeiling = structured(await pair(499_990));
      expect(atCeiling.rows).toEqual([{ pad: 'x'.repeat(499_990) }, { pad: 'x'.repeat(499_990) }]);
      expect(atCeiling.truncated).toBeUndefined();

      const past = failure(await pair(499_991));
      expect(past.data.reason).toBe('result_too_large');
      expect(past.data.replyBytes).toBe(1_000_002);
    });

    it('leaves the row past limit out of the bytes it measures', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      // Each row alone is the whole 1,000,000-byte ceiling; limit 1 returns the first.
      const result = await query(`SELECT repeat('x', 999990) AS pad FROM ${name} LIMIT 2`, 1);
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.rows).toEqual([{ pad: 'x'.repeat(999_990) }]);
      expect(sc.truncated).toBe(true);
      expect(sc.cap).toBe(1);
    });

    it('yields no row values for a SELECT past the ceiling', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      const read: Row[] = [];
      const getRowObjectsJson = DuckDBResultReader.prototype.getRowObjectsJson;
      vi.spyOn(DuckDBResultReader.prototype, 'getRowObjectsJson').mockImplementation(function (
        this: DuckDBResultReader,
      ) {
        const rows = getRowObjectsJson.call(this);
        read.push(...rows);
        return rows;
      });

      const result = await query(padded(name, 11_000));

      expect(failure(result).data.reason).toBe('result_too_large');
      expect(read.some((row) => 'pad' in row)).toBe(true);
      expect(read.filter((row) => 'pad' in row).every((row) => row.pad === null)).toBe(true);
    });

    it('returns rows and bytes only from the execution it measured, running the SELECT once', async () => {
      const name = await stageWonderTable(numberedWonderTable(5000), ['year']);
      // The gate parses and explains a statement without running it; a statement runs through these.
      const started = [
        vi.spyOn(DuckDBConnection.prototype, 'start'),
        vi.spyOn(DuckDBConnection.prototype, 'startStream'),
      ];
      const marker = 'measured_once';

      const sc = structured(await query(`SELECT deaths AS ${marker} FROM ${name}`, 10));

      expect(sc.columns).toEqual([marker]);
      expect(sc.rows.map((row) => row[marker])).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(sc.truncated).toBe(true);
      const runs = started
        .flatMap((spy) => spy.mock.calls.map(([sql]) => sql))
        .filter((sql) => sql.includes(marker));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.split(marker)).toHaveLength(2);
    });

    it('measures the rows at its limit, not every row the SELECT yields', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(padded(name, 11_000), 50);
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.rowCount).toBe(50);
      expect(sc.truncated).toBe(true);
      expect(sc.rows.every((row) => row.pad === 'x'.repeat(11_000))).toBe(true);
    });
  });

  describe('tables that are not staged', () => {
    it.each([
      ['a table that was never staged', false],
      ['a staged table since dropped', true],
    ])('fails missing_table for %s', async (_label, dropStaged) => {
      const staged = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      if (dropStaged) {
        const instance = await canvas.acquireShared(store, { create: false });
        await instance?.drop(staged);
      }
      const table = dropStaged ? staged : 'wonder_gone';

      const result = await query(`SELECT * FROM ${table}`);
      const error = failure(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(`Table ${table} is not staged on this server.`);
      expect(error.data.reason).toBe('missing_table');
      expect(error.data.tableName).toBe(table);
      expect(error.data.recovery).toEqual({ hint: MISSING_TABLE_HINT });
      expect(contentText(result)).toContain(`Recovery: ${MISSING_TABLE_HINT}`);
    });

    it('fails missing_table for any SELECT when nothing is staged', async () => {
      const result = await query('SELECT 1 AS one');
      const error = failure(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe(
        'Nothing is staged on this server yet, so the SELECT has no table to read.',
      );
      expect(error.data.reason).toBe('missing_table');
      expect(error.data).not.toHaveProperty('tableName');
      expect(error.data.recovery).toEqual({ hint: MISSING_TABLE_HINT });
      expect(contentText(result)).toContain(`Recovery: ${MISSING_TABLE_HINT}`);
    });
  });

  describe('the SQL gate', () => {
    it.each([
      ['a DROP', (name: string) => `DROP TABLE ${name}`, 'invalid_sql'],
      ['two statements', () => 'SELECT 1; SELECT 2', 'invalid_sql'],
      ['a file read', () => "SELECT * FROM read_csv('/etc/hosts')", 'denied_function'],
    ])('refuses %s as %s and leaves the staged table in place', async (_label, sql, reason) => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(sql(name));
      const error = failure(result);

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery).toEqual({ hint: expect.any(String) });
      const count = structured(await query(`SELECT count(*)::DOUBLE AS n FROM ${name}`));
      expect(count.rows).toEqual([{ n: TABLE_ROWS }]);
    });

    it.each([
      ['TRUNCATE', (name: string) => `TRUNCATE ${name}`, 'TRUNCATE'],
      ['CHECKPOINT', () => 'CHECKPOINT', 'CHECKPOINT'],
      ['VACUUM behind a comment', () => '-- tidy up\nvacuum', 'vacuum'],
      ['USE', () => '(USE memory)', 'USE'],
    ])(
      'refuses a %s statement as invalid_sql rather than as a table to stage',
      async (_label, sql, keyword) => {
        const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

        const result = await query(sql(name));
        const error = failure(result);

        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('invalid_sql');
        expect(error.message).toBe(
          `The SQL opens with ${keyword}, a statement other than a SELECT; only one read-only SELECT runs over the staged tables.`,
        );
        expect(error.data.recovery).toEqual({ hint: NOT_A_SELECT_HINT });
        expect(contentText(result)).not.toContain('is not staged');
        const count = structured(await query(`SELECT count(*)::DOUBLE AS n FROM ${name}`));
        expect(count.rows).toEqual([{ n: TABLE_ROWS }]);
      },
    );

    it.each([
      ['a number', '1'],
      ['a struct', "{'a': 1, 'b': 'two'}"],
    ])(
      'refuses a column named __proto__ holding %s, which no reply row can hold',
      async (_label, value) => {
        const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

        const result = await query(`SELECT ${value} AS "__proto__", deaths FROM ${name} LIMIT 1`);
        const error = failure(result);

        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data.reason).toBe('reserved_column_name');
        expect(error.message).toBe(
          'The SELECT returns a column named __proto__, which a reply row cannot hold as a key.',
        );
        expect(error.data.recovery).toEqual({ hint: RESERVED_COLUMN_HINT });
        expect(contentText(result)).toContain(`Recovery: ${RESERVED_COLUMN_HINT}`);
      },
    );

    it('returns columns named like other Object.prototype members', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const sc = structured(
        await query(`SELECT 3 AS "constructor", 4 AS "toString", deaths FROM ${name} LIMIT 1`),
      );

      expect(sc.columns).toEqual(['constructor', 'toString', 'deaths']);
      for (const row of sc.rows) expect(Object.keys(row)).toEqual(sc.columns);
    });

    it.each([
      ['a trailing semicolon', ';'],
      ['a trailing semicolon and whitespace', ';  \n'],
      ['a trailing line comment', ' -- first three rows'],
    ])('runs a SELECT that ends in %s', async (_label, suffix) => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      const whole = await wholeTable();

      const result = await query(`SELECT * FROM ${name} LIMIT 3${suffix}`);
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.rowCount).toBe(3);
      sc.rows.forEach((row, i) => {
        const expected = whole.rows[i] as WonderRow;
        expect(inlineColumns(row, expected)).toEqual(expected);
      });
    });

    it.each([
      ['an empty SQL string', { sql: '' }],
      ['a zero limit', { sql: 'SELECT 1', limit: 0 }],
    ])('rejects %s before the handler runs', async (_label, input) => {
      const result = await runToolContract(dataframeQuery, input);

      expect(result.isError).toBe(true);
      expect(failure(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    });
  });

  describe('format()', () => {
    it('renders a GFM table whose cells read back as the rows, nulls as empty cells', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      const columns = [
        'icd_subchapter',
        'cause_code',
        'deaths',
        'age_adjusted_rate',
        'age_adjusted_rate_status',
      ];

      const result = await query(
        `SELECT ${columns.join(', ')} FROM ${name} WHERE age_adjusted_rate_status IS NOT NULL`,
      );
      const sc = structured(result);
      const html = renderMarkdown(contentText(result));

      // The fixture flags four age-adjusted rates Unreliable; each reads null.
      expect(sc.rowCount).toBe(4);
      expect(sc.rows.every((row) => row.age_adjusted_rate === null)).toBe(true);
      expect(html).toContain('<table>');
      expect(readBack(html)).toContain('4 rows');
      const headers = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
        readBack(m[1] ?? ''),
      );
      expect(headers).toEqual(columns);
      const expected = sc.rows.flatMap((row) =>
        columns.map((column) => (row[column] === null ? '' : String(row[column]))),
      );
      expect(renderedCells(html).map(readBack)).toEqual(expected);
    });

    it('keys every row by the columns it lists when the SELECT repeats a column name', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(`SELECT deaths, deaths * 2 AS deaths FROM ${name} LIMIT 2`);
      const sc = structured(result);

      expect(new Set(sc.columns).size).toBe(sc.columns.length);
      for (const row of sc.rows) expect(Object.keys(row)).toEqual(sc.columns);
      const [first, second] = sc.columns as [string, string];
      for (const row of sc.rows) expect(row[second]).toBe((row[first] as number) * 2);
      const expected = sc.rows.flatMap((row) => sc.columns.map((column) => String(row[column])));
      expect(renderedCells(renderMarkdown(contentText(result))).map(readBack)).toEqual(expected);
    });

    it('returns a DOUBLE NaN or infinity as that string on both surfaces', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(
        `SELECT 'NaN'::DOUBLE AS a, 'Infinity'::DOUBLE AS b, '-Infinity'::DOUBLE AS c, deaths FROM ${name} LIMIT 1`,
      );
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.rows[0]).toEqual(
        expect.objectContaining({ a: 'NaN', b: 'Infinity', c: '-Infinity' }),
      );
      const cells = renderedCells(renderMarkdown(contentText(result))).map(readBack);
      expect(cells.slice(0, 3)).toEqual(['NaN', 'Infinity', '-Infinity']);
    });

    it('falls back to fenced JSON when a value would not survive a table cell', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(
        `SELECT cause_code || chr(10) || icd_subchapter AS label, deaths FROM ${name} LIMIT 2`,
      );
      const sc = structured(result);
      const text = contentText(result);

      expect(sc.rows[0]?.label).toContain('\n');
      expect(renderMarkdown(text)).not.toContain('<table>');
      const fenced = text.match(/```json\n([\s\S]*?)\n```/);
      expect(fenced).not.toBeNull();
      expect(JSON.parse(fenced?.[1] as string)).toEqual({ columns: sc.columns, rows: sc.rows });
    });

    it.each([
      [
        'a value with surrounding spaces',
        (name: string) => `SELECT ' padded ' AS label, deaths FROM ${name} LIMIT 2`,
        { label: ' padded ' },
      ],
      [
        'an empty string',
        (name: string) => `SELECT '' AS label, deaths FROM ${name} LIMIT 2`,
        { label: '' },
      ],
      [
        'a carriage return inside a value',
        (name: string) => `SELECT 'a' || chr(13) || 'b' AS label, deaths FROM ${name} LIMIT 2`,
        { label: 'a\rb' },
      ],
      [
        'a column alias with a trailing space',
        (name: string) => `SELECT deaths AS "two words " FROM ${name} LIMIT 2`,
        { 'two words ': expect.any(Number) },
      ],
    ])(
      'falls back to fenced JSON for %s, which a table would alter',
      async (_label, sql, first) => {
        const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

        const result = await query(sql(name));
        const sc = structured(result);
        const text = contentText(result);

        expect(sc.rowCount).toBe(2);
        expect(sc.rows[0]).toEqual(expect.objectContaining(first));
        expect(renderMarkdown(text)).not.toContain('<table>');
        const fenced = text.match(/```json\n([\s\S]*?)\n```/);
        expect(fenced).not.toBeNull();
        expect(JSON.parse(fenced?.[1] as string)).toEqual({ columns: sc.columns, rows: sc.rows });
      },
    );

    it('names the columns of an empty result, such as an offset past the end', async () => {
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

      const result = await query(`SELECT icd_chapter, deaths FROM ${name} LIMIT 10 OFFSET 500`);
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc).toMatchObject({ columns: ['icd_chapter', 'deaths'], rows: [], rowCount: 0 });
      expect(sc.truncated).toBeUndefined();
      expect(readBack(renderMarkdown(contentText(result)))).toContain(
        'Columns: icd_chapter, deaths',
      );
    });

    /**
     * Timing: the rows are whatever the caller's SELECT builds, up to the reply ceiling. Each
     * shape doubles from 5,000 characters to 320,000, and at every size the least of several
     * measurements stays under four times the growth against the 5,000-character base re-timed
     * beside it — under 256× at the full 64× span. The table, fenced-JSON, and empty renderings
     * are each covered.
     */
    describe('timing', () => {
      const inCell = (value: string) => ({
        columns: ['label'],
        rows: [{ label: value }],
        rowCount: 1,
      });
      const asColumn = (name: string) => ({ columns: [name], rows: [], rowCount: 0 });

      it.each<[string, (n: number) => string, typeof inCell, number]>([
        ['one long line ending in a break', (n) => `${fill('§1 x', n)}\ny`, inCell, 20],
        ['line breaks throughout', (n) => fill('  \r\n', n), inCell, 20],
        ['a table cell of Markdown punctuation', (n) => fill('*_|<&\\`x', n), inCell, 5],
        ['backtick runs in fenced JSON', (n) => `${fill('`a``', n)}\n`, inCell, 20],
        ['one backtick run in fenced JSON', (n) => `${fill('`', n)}\n`, inCell, 20],
        ['a long column name with no rows', (n) => fill('`a``', n), asColumn, 20],
      ])(
        'stays linear on %s',
        (_name, build, wrap, repeats) =>
          expectLinearDoublings(
            build,
            320_000,
            (text) => dataframeQuery.format!(wrap(text)),
            repeats,
          ),
        0,
      );
    });
  });
});

describe('leadingWord', () => {
  it.each([
    ['a statement keyword', 'TRUNCATE wonder_x', 'TRUNCATE'],
    ['a bare keyword', 'CHECKPOINT', 'CHECKPOINT'],
    ['a word behind a line comment', '-- tidy up\nvacuum', 'vacuum'],
    ['a word inside an opening parenthesis', '(USE memory)', 'USE'],
    ['a SELECT', 'SELECT * FROM wonder_gone', 'SELECT'],
    ['a word behind a block comment and parentheses', '/* note */ ( (\tcheckpoint', 'checkpoint'],
    ['a word behind comments of both kinds', '/* a */ -- b\r\n/**/\n_x9 y', '_x9'],
    ['a word right after an empty block comment', '/**/USE', 'USE'],
  ])('reads the opening word of %s', (_label, sql, word) => {
    expect(leadingWord(sql)).toBe(word);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace and parentheses alone', ' ( \n( '],
    ['a quoted name first', '"wonder_x"'],
    ['a quoted name behind a line comment', '-- wonder_x\n"wonder_x"'],
    ['a number first', '1 + 1'],
    ['a line comment left open', '-- vacuum'],
    ['a block comment left open', '/* vacuum'],
    ['a block comment whose */ shares the opener’s *', '/*/ vacuum'],
  ])('reads no opening word from %s', (_label, sql) => {
    expect(leadingWord(sql)).toBeUndefined();
  });

  /**
   * Timing: the SQL is the caller's, so its length is bounded only by the request body. Each
   * input doubles from 5,000 characters to 320,000, and at every size the least of several
   * measurements stays under four times the growth against the 5,000-character base re-timed
   * beside it — under 256× at the full 64× span.
   */
  describe('timing', () => {
    it.each<[(n: number) => string]>([
      [(n) => `-- ${fill('§1 x', n)}\ny`],
      [(n) => fill('  \r\n', n)],
      [(n) => fill('--\r\n', n)],
      [(n) => fill('--', n)],
      [(n) => `/*${fill('*//*', n)}`],
      [(n) => fill('/**/(', n)],
      [(n) => `${fill('/**/', n)}/*`],
    ])(
      'stays linear on input %#',
      (build) => expectLinearDoublings(build, 320_000, leadingWord, 50),
      0,
    );
  });
});
