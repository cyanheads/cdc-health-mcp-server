/**
 * @fileoverview A staged WONDER table: its canvas projection (the inline row's columns in
 * order, then a `<measure>_status` column for each measure the rows carry, under a declared
 * schema and a freshly minted `wonder_` name), and its lifetime on the canvas — an hour past
 * the last query that read it, and at most `MAX_STAGED_TABLES` on one canvas.
 * @module services/wonder/staged-table
 */

import type {
  CanvasInstance,
  ColumnSchema,
  ColumnType,
  TableInfo,
} from '@cyanheads/mcp-ts-core/canvas';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import {
  WONDER_MEASURES,
  WONDER_RATE_MEASURES,
  type WonderCellNote,
  type WonderRow,
} from './types.js';

/** How long a staged table survives unused; every query that reads it slides this forward. */
const STAGED_TABLE_TTL_MS = 3_600_000;

/**
 * Most tables one canvas holds. The framework caps neither the tables on a canvas nor their
 * memory, and every caller of a deployment without auth shares one canvas, so this bounds the
 * canvas's memory; staging past it drops the earliest-expiring tables first.
 */
export const MAX_STAGED_TABLES = 200;

const NAME_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const NAME_LENGTH = 10;

/**
 * Every measure and each rate's interval bounds. `DOUBLE`, not an integer type: a multi-year
 * row's population passes `INTEGER`'s range, and a `BIGINT` value comes back from a query as a
 * string rather than a number.
 */
const DOUBLE_COLUMNS: ReadonlySet<string> = new Set([
  ...WONDER_MEASURES,
  ...WONDER_RATE_MEASURES.flatMap((rate) => [`${rate}_lower`, `${rate}_upper`]),
]);

/**
 * The declared type of a staged column. The schema is never sniffed: a leading run of null
 * rates would sniff as the wrong type and the appender would coerce every later value to it.
 */
function columnType(name: string): ColumnType {
  if (DOUBLE_COLUMNS.has(name)) return 'DOUBLE';
  if (name === 'cause_level') return 'INTEGER';
  return 'VARCHAR';
}

/** A WONDER table ready for `registerTable`. */
export interface StagedTable {
  /** `wonder_` plus 10 random lowercase letters and digits, minted per staging. */
  name: string;
  /** The parsed rows with their status columns, in CDC's order. */
  rows: WonderRow[];
  schema: ColumnSchema[];
}

/**
 * Project a whole parsed table onto its staged form. `cellNotes` index into `rows` (the whole
 * table's numbering, never a page's); each status column holds CDC's token for that cell, or
 * null where the cell carried a number.
 *
 * @throws Error when `rows` is empty — the columns are read from the first row, and an empty
 *   table is never staged.
 */
export function stagedTable(
  rows: readonly WonderRow[],
  cellNotes: readonly WonderCellNote[],
): StagedTable {
  const first = rows[0];
  if (!first) throw new Error('stagedTable needs at least one row to read the columns from.');

  const keys = Object.keys(first);
  const statusOf = WONDER_MEASURES.filter((measure) => keys.includes(measure)).map(
    (measure) => [measure, `${measure}_status`] as const,
  );
  const tokens = new Map(cellNotes.map((note) => [`${note.row}:${note.column}`, note.token]));

  return {
    name: `wonder_${idGenerator.generateRandomString(NAME_LENGTH, NAME_CHARSET)}`,
    rows: rows.map((row, index) => {
      const staged: WonderRow = { ...row };
      for (const [measure, status] of statusOf) {
        staged[status] = tokens.get(`${index}:${measure}`) ?? null;
      }
      return staged;
    }),
    schema: [
      ...keys.map((name) => ({ name, type: columnType(name) })),
      ...statusOf.map(([, name]) => ({ name, type: 'VARCHAR' as const })),
    ],
  };
}

/** When `table` is dropped unless a query reads it, in epoch ms; every staged table has one. */
const expiresAtMs = (table: TableInfo): number => Date.parse(table.expiresAt ?? '');

/**
 * Register `table` on `instance`, dropped an hour after the last query that reads it. First,
 * while the canvas holds `MAX_STAGED_TABLES` or more tables, drop the one that expires first
 * (by name among tables that expire at the same instant, so the choice is deterministic). The
 * tables are counted before the registration, so stagings running at once on one canvas can each
 * find room and pass the cap by at most their number; the WONDER request lane spaces stagings 16
 * seconds apart, far longer than one takes.
 *
 * @returns How many tables were dropped to make room.
 * @throws Whatever the canvas throws listing, dropping, or registering tables, cancellation
 *   included, as it raises it.
 */
export async function stageTable(
  instance: CanvasInstance,
  table: StagedTable,
  signal: AbortSignal,
): Promise<number> {
  const held = await instance.describe({ signal });
  const evicted = held
    .toSorted((a, b) => expiresAtMs(a) - expiresAtMs(b) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, held.length - MAX_STAGED_TABLES + 1));
  for (const { name } of evicted) {
    await instance.drop(name);
  }

  await instance.registerTable(table.name, table.rows, {
    schema: table.schema,
    ttlMs: STAGED_TABLE_TTL_MS,
    signal,
  });
  return evicted.length;
}
