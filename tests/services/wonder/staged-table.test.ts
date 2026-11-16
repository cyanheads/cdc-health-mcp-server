/**
 * @fileoverview The canvas projection of a parsed WONDER table — column order, status columns,
 * the declared schema, the table name — checked on tables parsed from captured WONDER
 * responses, then registered on a real DuckDB canvas to show the declared types hold the
 * values CDC sends.
 * @module tests/services/wonder/staged-table
 */

import { readFileSync } from 'node:fs';
import { assertValidIdentifier, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stagedTable } from '@/services/wonder/staged-table.js';
import {
  WONDER_GROUP_BY,
  type WonderGroupBy,
  type WonderQueryOptions,
  type WonderResult,
} from '@/services/wonder/types.js';
import { getWonderService, initWonderService } from '@/services/wonder/wonder-service.js';
import { createStagingCanvas, disposeStagingCanvas } from '../../helpers/staging-canvas.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/wonder/${name}`, import.meta.url), 'utf8');

/** One parse of a captured response through the real service, with only `fetch` faked. */
async function parsed(
  name: string,
  groupBy: WonderGroupBy[],
  options: Partial<WonderQueryOptions> = {},
): Promise<WonderResult> {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fixture(name), { status: 200 }));
  return getWonderService().query({ database: 'underlying_1999_2020', groupBy, ...options });
}

const STATUS_COLUMNS = [
  'deaths_status',
  'population_status',
  'crude_rate_status',
  'age_adjusted_rate_status',
];

describe('stagedTable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the inline columns in order, then one status column per measure', async () => {
    const result = await parsed('d76-icd-chapter-and-subchapter.response.xml', [
      'icd_chapter',
      'icd_subchapter',
    ]);
    const table = stagedTable(result.rows, result.cellNotes);

    expect(table.schema).toEqual([
      { name: 'icd_chapter', type: 'VARCHAR' },
      { name: 'icd_subchapter', type: 'VARCHAR' },
      { name: 'cause_code', type: 'VARCHAR' },
      { name: 'deaths', type: 'DOUBLE' },
      { name: 'population', type: 'DOUBLE' },
      { name: 'crude_rate', type: 'DOUBLE' },
      { name: 'crude_rate_lower', type: 'DOUBLE' },
      { name: 'crude_rate_upper', type: 'DOUBLE' },
      { name: 'age_adjusted_rate', type: 'DOUBLE' },
      { name: 'age_adjusted_rate_lower', type: 'DOUBLE' },
      { name: 'age_adjusted_rate_upper', type: 'DOUBLE' },
      ...STATUS_COLUMNS.map((name) => ({ name, type: 'VARCHAR' })),
    ]);
    expect(table.rows).toHaveLength(177);
    for (const row of table.rows) {
      expect(Object.keys(row)).toEqual(table.schema.map((column) => column.name));
    }
  });

  it("carries CDC's token in the status column of exactly the cells cellNotes flag", async () => {
    const result = await parsed('d76-icd-chapter-and-subchapter.response.xml', [
      'icd_chapter',
      'icd_subchapter',
    ]);
    const table = stagedTable(result.rows, result.cellNotes);

    // The fixture flags four crude and four age-adjusted rates as Unreliable, nothing else.
    expect(result.cellNotes).toHaveLength(8);
    const flagged = table.rows.flatMap((row, index) =>
      STATUS_COLUMNS.flatMap((column) =>
        row[column] === null ? [] : [{ row: index, column, token: row[column] }],
      ),
    );
    expect(flagged).toEqual(
      result.cellNotes.map((note) => ({
        row: note.row,
        column: `${note.column}_status`,
        token: 'Unreliable',
      })),
    );
    for (const note of result.cellNotes) {
      expect(table.rows[note.row]?.[note.column]).toBeNull();
    }
  });

  it('declares cause_level as INTEGER and adds no status column for a measure the rows lack', async () => {
    const nested = await parsed('d77-cause-113-2019.response.xml', ['cause_113'], {
      database: 'multiple_1999_2020',
    });
    const nestedTable = stagedTable(nested.rows, nested.cellNotes);
    expect(nestedTable.schema.slice(0, 2)).toEqual([
      { name: 'cause_113', type: 'VARCHAR' },
      { name: 'cause_level', type: 'INTEGER' },
    ]);

    // Grouped by age group, CDC sends no age-adjusted rate, so nothing stands for one.
    const byAge = await parsed('d76-year-age-sex-race.response.xml', [
      'year',
      'age_group',
      'sex',
      'race',
    ]);
    const byAgeTable = stagedTable(byAge.rows, byAge.cellNotes);
    const names = byAgeTable.schema.map((column) => column.name);
    expect(names).not.toContain('age_adjusted_rate');
    expect(names.slice(-3)).toEqual(['deaths_status', 'population_status', 'crude_rate_status']);
    expect(
      byAgeTable.rows.filter((row) => row.crude_rate_status === 'Not Applicable'),
    ).toHaveLength(byAge.cellNotes.filter((n) => n.column === 'crude_rate').length);
  });

  it('names every table wonder_ plus 10 lowercase letters and digits, fresh per staging', async () => {
    const result = await parsed('d76-icd-chapter-2019.response.xml', ['icd_chapter']);
    const names = Array.from({ length: 20 }, () => stagedTable(result.rows, []).name);

    for (const name of names) expect(name).toMatch(/^wonder_[a-z0-9]{10}$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it('produces only names the canvas accepts as identifiers, for every grouping dimension', () => {
    const row = Object.fromEntries(
      [
        ...WONDER_GROUP_BY,
        'cause_code',
        'cause_level',
        'deaths',
        'population',
        'crude_rate',
        'crude_rate_lower',
        'crude_rate_upper',
        'age_adjusted_rate',
        'age_adjusted_rate_lower',
        'age_adjusted_rate_upper',
      ].map((key) => [key, null]),
    );
    const table = stagedTable([row], []);

    assertValidIdentifier(table.name, 'table');
    for (const column of table.schema) assertValidIdentifier(column.name, 'column');
    expect(table.schema).toHaveLength(Object.keys(row).length + STATUS_COLUMNS.length);
  });

  it('refuses an empty table, which has no row to read the columns from', () => {
    expect(() => stagedTable([], [])).toThrow('at least one row');
  });
});

describe('stagedTable on a real canvas', () => {
  let canvas: DataCanvas;

  beforeAll(() => {
    canvas = createStagingCanvas();
  });

  afterAll(async () => {
    await disposeStagingCanvas(canvas);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds a multi-year population past the INTEGER range as a JSON number', async () => {
    const result = await parsed('d76-icd-chapter-and-subchapter.response.xml', [
      'icd_chapter',
      'icd_subchapter',
    ]);
    const table = stagedTable(result.rows, result.cellNotes);
    const instance = await canvas.acquireShared(createMockContext({ tenantId: 'population' }));
    await instance.registerTable(table.name, table.rows, { schema: table.schema });

    const { rows } = await instance.query(`SELECT max(population) AS p FROM ${table.name}`);
    expect(rows).toEqual([{ p: 6746356647 }]);
  });

  it('reads cause_level back as an integer and the status columns as text', async () => {
    const result = await parsed('d77-cause-113-2019.response.xml', ['cause_113'], {
      database: 'multiple_1999_2020',
    });
    const table = stagedTable(result.rows, result.cellNotes);
    const instance = await canvas.acquireShared(createMockContext({ tenantId: 'levels' }));
    await instance.registerTable(table.name, table.rows, { schema: table.schema });

    const { rows } = await instance.query(
      `SELECT * FROM ${table.name} LIMIT ${result.rows.length}`,
      { rowLimit: result.rows.length },
    );
    expect(rows).toEqual(table.rows);
    expect(rows.every((row) => Number.isInteger(row.cause_level))).toBe(true);
    const [described] = await instance.describe({ tableName: table.name });
    expect(described?.columns.find((c) => c.name === 'cause_level')?.engineType).toBe('INTEGER');
    expect(described?.columns.find((c) => c.name === 'deaths_status')?.engineType).toBe('VARCHAR');
  });
});
