/**
 * @fileoverview cdc_dataframe_describe over a real DuckDB canvas, with tables staged through
 * cdc_query_wonder from WONDER responses served by a faked `fetch`: nothing staged, a listed
 * table's row count, expiry, and columns, the table filter, and a table that is not staged.
 * @module tests/mcp-server/tools/definitions/dataframe-describe.tool
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import type { WonderGroupBy } from '@/services/wonder/types.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';
import { contentText } from '../../../helpers/contract-text.js';
import { readBack, renderMarkdown } from '../../../helpers/markdown-render.js';
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
const HOUR_MS = 3_600_000;

const NOTHING_STAGED =
  'Nothing is staged. cdc_query_wonder stages the whole WONDER table when a call at offset 0 leaves rows past the page it returns — any grouping larger than the page — and names the table in stagedTable.';
const MISSING_TABLE_HINT =
  'Call cdc_dataframe_describe without table to list the tables staged now, or call cdc_query_wonder again at offset 0 to stage the table afresh and use the name it returns.';

/** The columns a table staged from the chapter × sub-chapter response holds, in order. */
const CHAPTER_SUBCHAPTER_COLUMNS = [
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
  { name: 'deaths_status', type: 'VARCHAR' },
  { name: 'population_status', type: 'VARCHAR' },
  { name: 'crude_rate_status', type: 'VARCHAR' },
  { name: 'age_adjusted_rate_status', type: 'VARCHAR' },
];

interface DescribedTable {
  columns: { name: string; type: string }[];
  expiresAt?: string;
  name: string;
  rowCount: number;
}
type Described = { tables: DescribedTable[]; notice?: string };
type ToolError = { code: number; message: string; data: Record<string, unknown> };

async function describeTables(input: Record<string, unknown> = {}) {
  const result = await runToolContract(dataframeDescribe, input);
  return { result, sc: result.structuredContent as Described };
}

describe('cdc_dataframe_describe', () => {
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
    vi.useRealTimers();
  });

  it('returns no tables and says how to stage one when nothing is staged', async () => {
    const canvases = canvas.countForTenant(store);
    const { result, sc } = await describeTables();

    expect(result.isError).toBeFalsy();
    expect(sc).toEqual({ tables: [], notice: NOTHING_STAGED });
    const shown = readBack(renderMarkdown(contentText(result)));
    expect(shown).toContain('No staged tables.');
    expect(shown).toContain(NOTHING_STAGED);
    // Describing never mints a canvas of its own.
    expect(canvas.countForTenant(store)).toBe(canvases);
  });

  it('returns no tables, with the same notice, once every staged table is gone', async () => {
    const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
    const instance = await canvas.acquireShared(store, { create: false });
    await instance?.drop(name);

    const { result, sc } = await describeTables();

    expect(result.isError).toBeFalsy();
    expect(sc).toEqual({ tables: [], notice: NOTHING_STAGED });
    expect(readBack(renderMarkdown(contentText(result)))).toContain('No staged tables.');
  });

  it('lists a staged table with its row count, its columns, and an expiry an hour out', async () => {
    const before = Date.now();
    const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
    const after = Date.now();

    const { result, sc } = await describeTables();

    expect(result.isError).toBeFalsy();
    expect(sc.notice).toBeUndefined();
    expect(sc.tables).toHaveLength(1);
    const [table] = sc.tables as [DescribedTable];
    expect(table.name).toBe(name);
    expect(table.rowCount).toBe(177);
    expect(table.columns).toEqual(CHAPTER_SUBCHAPTER_COLUMNS);
    const expiresAt = Date.parse(table.expiresAt ?? '');
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + HOUR_MS);

    const shown = readBack(renderMarkdown(contentText(result)));
    expect(shown).toContain(`${name} — 177 rows, dropped at ${table.expiresAt} unless read`);
    for (const column of CHAPTER_SUBCHAPTER_COLUMNS) {
      expect(shown).toContain(`${column.name} ${column.type}`);
    }
  });

  it('moves the expiry an hour past each cdc_dataframe_query that reads the table', async () => {
    // A canvas of its own, built while the clock is held, so its expiries follow that clock.
    const start = Date.parse('2026-11-16T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    vi.restoreAllMocks();
    const held = createStagingCanvas();
    try {
      shareTenantStore(held);
      const name = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
      const [staged] = (await describeTables()).sc.tables;
      expect(staged?.expiresAt).toBe(new Date(start + HOUR_MS).toISOString());

      const readAt = start + 20 * 60_000;
      vi.setSystemTime(readAt);
      const read = await runToolContract(dataframeQuery, { sql: `SELECT count(*) FROM ${name}` });
      expect(read.isError).toBeFalsy();

      const [afterRead] = (await describeTables()).sc.tables;
      expect(afterRead?.expiresAt).toBe(new Date(readAt + HOUR_MS).toISOString());
    } finally {
      await disposeStagingCanvas(held);
      setCanvas(canvas);
    }
  });

  it('describes only the table named by table', async () => {
    const chapters = await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);
    const years = await stageWonderTable(numberedWonderTable(150), ['year']);

    const all = await describeTables();
    expect(all.sc.tables.map((table) => table.name).sort()).toEqual([chapters, years].sort());

    const { result, sc } = await describeTables({ table: years });

    expect(result.isError).toBeFalsy();
    expect(sc.tables).toHaveLength(1);
    const [table] = sc.tables as [DescribedTable];
    expect(table.name).toBe(years);
    expect(table.rowCount).toBe(150);
    expect(table.columns.map((column) => column.name)).toEqual([
      'year',
      'deaths',
      'population',
      'crude_rate',
      'crude_rate_lower',
      'crude_rate_upper',
      'age_adjusted_rate',
      'age_adjusted_rate_lower',
      'age_adjusted_rate_upper',
      'deaths_status',
      'population_status',
      'crude_rate_status',
      'age_adjusted_rate_status',
    ]);
    const shown = readBack(renderMarkdown(contentText(result)));
    expect(shown).toContain(`${years} — 150 rows`);
    expect(shown).not.toContain(chapters);
  });

  it.each([
    ['another table is staged', true],
    ['nothing is staged at all', false],
  ])('fails missing_table for a table that is not staged when %s', async (_label, stageOne) => {
    if (stageOne) await stageWonderTable(CHAPTER_SUBCHAPTER, GROUPING);

    const { result } = await describeTables({ table: 'wonder_gone' });
    const error = (result.structuredContent as { error: ToolError }).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe('No table named wonder_gone is staged on this server.');
    expect(error.data.reason).toBe('missing_table');
    expect(error.data.tableName).toBe('wonder_gone');
    expect(error.data.recovery).toEqual({ hint: MISSING_TABLE_HINT });
    expect(contentText(result)).toContain(`Recovery: ${MISSING_TABLE_HINT}`);
  });

  it('refuses a table name that cannot name a staged table, before any lookup', async () => {
    const { result } = await describeTables({ table: 'wonder-gone' });
    const error = (result.structuredContent as { error: ToolError }).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data.reason).toBe('invalid_arguments');
  });
});
