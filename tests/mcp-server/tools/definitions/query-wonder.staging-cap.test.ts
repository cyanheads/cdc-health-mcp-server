/**
 * @fileoverview The bound on how many tables cdc_query_wonder keeps staged on one canvas: at
 * most 200, the earliest-expiring dropped to make room, and a dropped table answering
 * missing_table. Each case seeds the canvas with tables registered directly under the staging
 * TTL, then stages through cdc_query_wonder — the real WonderService with only `fetch` faked —
 * over a real DuckDB canvas built under a held `Date` with its sweeper off, so every expiry
 * follows the held clock and nothing expires on its own.
 * @module tests/mcp-server/tools/definitions/query-wonder.staging-cap
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  type TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { getWonderService, initWonderService } from '@/services/wonder/wonder-service.js';
import type { ContractError } from '../../../helpers/contract-error.js';
import { contentText } from '../../../helpers/contract-text.js';
import {
  createStagingCanvas,
  disposeStagingCanvas,
  numberedWonderTable,
  shareTenantStore,
  stageWonderTable,
} from '../../../helpers/staging-canvas.js';

const CAP = 200;
const HOUR_MS = 3_600_000;
const START = Date.parse('2026-11-16T12:00:00.000Z');
/** One row past the 100-row default page, so every call at offset 0 stages it. */
const BODY = numberedWonderTable(101);
const SEED_SCHEMA: ColumnSchema[] = [
  { name: 'year', type: 'VARCHAR' },
  { name: 'deaths', type: 'DOUBLE' },
];
const MISSING_TABLE_HINT =
  'Call cdc_dataframe_describe to list the tables staged now, or call cdc_query_wonder again at offset 0 to stage the table afresh and query the name it returns.';

const failure = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { error: ContractError }).error;

/** Move the held clock forward by `ms`. */
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Earliest expiry first, as the canvas reports each table's. */
function byExpiry(a: TableInfo, b: TableInfo): number {
  return Date.parse(a.expiresAt ?? '') - Date.parse(b.expiresAt ?? '');
}

describe('cdc_query_wonder — at most 200 staged tables per canvas', () => {
  let canvas: DataCanvas;
  let store: Context;
  let seeded = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    canvas = createStagingCanvas({ CANVAS_SWEEPER_INTERVAL_MS: '0' });
    store = shareTenantStore(canvas);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disposeStagingCanvas(canvas);
    vi.useRealTimers();
  });

  /** The store's canvas, minted on first use as staging mints it. */
  const instance = () => canvas.acquireShared(store);

  /** Register `n` tables directly under the staging TTL, a second apart; returns their names. */
  async function seed(n: number): Promise<string[]> {
    const target = await instance();
    const names: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const name = `wonder_seed${String(seeded).padStart(6, '0')}`;
      seeded += 1;
      await target.registerTable(name, [{ year: '1999', deaths: i }], {
        schema: SEED_SCHEMA,
        ttlMs: HOUR_MS,
      });
      names.push(name);
      advance(1_000);
    }
    return names;
  }

  /** Stage one 101-row table through cdc_query_wonder, a second after the last; returns its name. */
  async function stage(): Promise<string> {
    const name = await stageWonderTable(BODY, ['year']);
    advance(1_000);
    return name;
  }

  /** Every table on the canvas, as it describes them. */
  const staged = async (): Promise<TableInfo[]> => (await instance()).describe();

  /** Whether `name` is on the canvas. */
  const isStaged = async (name: string) =>
    (await (await instance()).describe({ tableName: name })).length === 1;

  /** Read `name` through cdc_dataframe_query. */
  async function read(name: string): Promise<void> {
    const result = await runToolContract(dataframeQuery, { sql: `SELECT count(*) FROM ${name}` });
    expect(result.isError).toBeFalsy();
  }

  it('never holds more than 200 tables, however many are staged past them', async () => {
    const seeds = await seed(CAP);
    const later = [await stage(), await stage()];

    // Each staging dropped the table that expired first: the earliest seeded here.
    const held = (await staged()).map((table) => table.name).sort();
    expect(held).toEqual([...seeds.slice(2), ...later].sort());
  });

  it('drops the table that expires first — one read long ago before one read recently, whichever was staged first', async () => {
    const [first, second] = (await seed(2)) as [string, string];
    advance(10_000);
    await read(second); // expires an hour from now
    advance(10_000);
    await read(first); // expires 10 seconds after it
    advance(10_000);
    await seed(CAP - 2);
    const [soonest] = (await staged()).toSorted(byExpiry);
    expect(soonest?.name).toBe(second);

    const added = await stage();

    expect(await isStaged(second)).toBe(false);
    expect(await isStaged(first)).toBe(true);
    expect(await isStaged(added)).toBe(true);
  });

  it('fails cdc_dataframe_query on a dropped table with missing_table and its recovery hint', async () => {
    const [dropped] = await seed(CAP);
    await stage();

    const result = await runToolContract(dataframeQuery, { sql: `SELECT * FROM ${dropped}` });
    const error = failure(result);

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.message).toBe(`Table ${dropped} is not staged on this server.`);
    expect(error.data.reason).toBe('missing_table');
    expect(error.data.tableName).toBe(dropped);
    expect(error.data.recovery).toEqual({ hint: MISSING_TABLE_HINT });
    expect(contentText(result)).toContain(`Recovery: ${MISSING_TABLE_HINT}`);
  });

  it.each([
    ['listing the staged tables', 'describe'],
    ['dropping the earliest-expiring table', 'drop'],
  ] as const)('fails staging_failed when %s fails at the cap', async (_label, method) => {
    const seeds = await seed(CAP);
    vi.spyOn(CanvasInstance.prototype, method).mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.DatabaseError, 'IO Error: the engine could not be reached.'),
    );

    initWonderService();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(BODY, { status: 200 }));
    const result = await runToolContract(queryWonder, { group_by: ['year'] });
    const error = failure(result);

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('staging_failed');
    expect(error.data.retryable).toBe(true);
    expect(error.message).toBe(
      'WONDER returned the 101-row table, but it could not be staged for SQL beside this page.',
    );
    expect((await staged()).map((table) => table.name)).toEqual(seeds);
  });

  it('rejects as cancelled, dropping nothing, when the call is cancelled before the table stages', async () => {
    const seeds = await seed(CAP);
    initWonderService();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(BODY, { status: 200 }));
    const parsed = await getWonderService().query({
      database: 'underlying_1999_2020',
      groupBy: ['year'],
      sex: 'all',
    });
    const controller = new AbortController();
    // WONDER answers, then the caller gives up before the table is staged.
    vi.spyOn(getWonderService(), 'query').mockImplementation(async () => {
      controller.abort(new Error('The caller went away while the table staged.'));
      return parsed;
    });

    const result = await runToolContract(
      queryWonder,
      { group_by: ['year'] },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    expect(failure(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(contentText(result)).not.toContain('could not be staged');
    expect((await staged()).map((table) => table.name)).toEqual(seeds);
  });
});
