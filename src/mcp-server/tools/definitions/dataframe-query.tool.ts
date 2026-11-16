/**
 * @fileoverview Tool to run one read-only SQL SELECT over the WONDER tables cdc_query_wonder
 * staged on this server's DataCanvas.
 * @module mcp-server/tools/definitions/dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { QueryResult } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { markdown } from '@cyanheads/mcp-ts-core/utils';
import { liveCanvas } from '@/services/canvas-accessor.js';
import { MAX_STAGED_TABLES } from '@/services/wonder/staged-table.js';
import { escapeTableCell, markdownCodeSpan } from '@/utils/markdown.js';

/** Rows returned when the caller names no limit. */
const DEFAULT_LIMIT = 100;
/** Most rows one call returns; a larger limit is lowered to this with a notice. */
const MAX_LIMIT = 1_000;
/** Ceiling on one reply: the returned rows as JSON, measured in the engine. */
const MAX_REPLY_BYTES = 1_000_000;

const count = (n: number) => n.toLocaleString('en-US');

/**
 * The caller's SELECT as one statement that measures the rows it yields, so the rows and bytes
 * returned come from the execution that was measured and the reply stays within `limit` rows and
 * {@link MAX_REPLY_BYTES}. The SELECT is cut to `limit + 1` rows; each row is packed whole into
 * one struct, so no column name the SELECT returns can stand in for the wrapper's own, and
 * numbered in the SELECT's order. Over those rows the engine counts them — one past `limit`
 * says rows remain — and sums the JSON size of the first `limit`. Within the ceiling the
 * statement yields those rows unpacked, in order; past it, one row whose columns are null. The
 * statement's output is never more than `limit` rows.
 *
 * Each row ends in two measurements, `reply_rows` and `reply_bytes`, after the SELECT's own
 * columns. Read as a subquery, a column name the SELECT repeats comes back suffixed (`deaths`,
 * `deaths_1`), and a SELECT column already named like a measurement suffixes the measurement
 * instead, so the measurements are the last two columns whatever their names. A statement the
 * gate accepts on its own has balanced parentheses and closes every literal and comment it
 * opens, so it sits inside the wrapper as one subquery; anything else fails the gate here, as
 * invalid SQL. The wrapper text after the SELECT stands on short lines of its own, the last a
 * lone `)`, so a parse error found past the caller's text quotes little of it.
 */
function replyQuery(sql: string, limit: number): string {
  return `SELECT * FROM (SELECT unnest(CASE WHEN m.reply_bytes <= ${MAX_REPLY_BYTES} THEN m.r END), m.reply_rows, m.reply_bytes FROM (SELECT p.r, p.ord, count(*) OVER ()::DOUBLE AS reply_rows, (sum(strlen(CAST(to_json(p.r) AS VARCHAR))) FILTER (WHERE p.ord <= ${limit}) OVER ())::DOUBLE AS reply_bytes FROM (SELECT struct_pack(*COLUMNS(*)) AS r, row_number() OVER () AS ord FROM (SELECT * FROM (\n${sql}\n)\nLIMIT ${limit + 1})) AS p) AS m\nWHERE m.ord <= ${limit} AND (m.reply_bytes <= ${MAX_REPLY_BYTES} OR m.ord = 1)\nORDER BY m.ord\n)`;
}

/** The first word of the caller's SQL past leading whitespace, comments, and opening parentheses. */
function leadingWord(sql: string): string | undefined {
  return /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/|\()*([A-Za-z_][A-Za-z0-9_]*)/.exec(sql)?.[1];
}

/** The caller's SQL without one trailing semicolon, which cannot sit inside a subquery. */
function statementBody(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * A value a GFM table cell carries losslessly: a number, a boolean, null (an empty cell), or a
 * non-empty single-line string with no surrounding whitespace, which `escapeTableCell` leaves
 * reading back as written.
 */
function fitsTableCell(value: unknown): boolean {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.trim() === value &&
    !value.includes('\n') &&
    !value.includes('\r')
  );
}

export const dataframeQuery = tool('cdc_dataframe_query', {
  title: 'Query Staged WONDER Tables',
  description: `Run one read-only SQL SELECT, in DuckDB's dialect, over the tables cdc_query_wonder staged on this server — rank, compare, aggregate, or join a whole WONDER table without another WONDER request. Reference a table by the name cdc_query_wonder returned in stagedTable or cdc_dataframe_describe lists. A staged table keeps CDC's row order, so SELECT * FROM <name> LIMIT <n> OFFSET <m> continues a cdc_query_wonder page where it stopped. Its columns are the inline rows' columns, then a <measure>_status column for each measure holding the token CDC returned in place of the value ("Suppressed", "Unreliable", "Not Applicable"), null where the value is a number; a null value sorts last in ORDER BY in either direction. Dimension columns are text, so a year compares as '2024'. count(*) and other BIGINT results come back as strings; cast to DOUBLE for a number. limit caps the rows returned — ${DEFAULT_LIMIT} when omitted, at most ${count(MAX_LIMIT)}, with a larger limit lowered and a notice saying so — and truncated says more rows remain. One reply holds at most ${count(MAX_REPLY_BYTES)} bytes of rows as JSON, measured before any row is returned; a SELECT past it fails result_too_large, so select fewer or narrower columns, aggregate, or lower limit. Only a single SELECT runs: other statements, file and network reads, and functions that read settings are refused. A table is dropped an hour after the last query that read it, or earlier, earliest-expiring first, once ${MAX_STAGED_TABLES} are staged.`,
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: `The SQL names a table that is not staged — dropped after an hour unread or earlier to make room once ${MAX_STAGED_TABLES} were staged, never staged, or mistyped — or nothing is staged on this server yet.`,
      recovery:
        'Call cdc_dataframe_describe to list the tables staged now, or call cdc_query_wonder again at offset 0 to stage the table afresh and query the name it returns.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SQL is not one read-only SELECT: another statement, several statements, or a SELECT that does not parse or names something that does not exist.',
      recovery:
        'Send one read-only SELECT over the staged tables; statements other than a SELECT are refused.',
    },
    {
      reason: 'reserved_column_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The SELECT returns a column named __proto__, which a reply row cannot hold as a key.',
      recovery:
        'Rename the column with AS to any other name, such as AS proto, and retry the SELECT.',
    },
    {
      reason: 'result_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: `The rows the SELECT returns at its limit total more than ${count(MAX_REPLY_BYTES)} bytes as JSON.`,
      recovery: `Select fewer or narrower columns, aggregate, or lower limit so the rows returned stay under ${count(MAX_REPLY_BYTES)} bytes, then retry.`,
    },
  ],

  input: z.object({
    sql: z
      .string()
      .min(1)
      .describe(
        'One read-only SELECT (DuckDB SQL) over staged tables, named as stagedTable or cdc_dataframe_describe gives them. A trailing semicolon is accepted.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_LIMIT)
      .describe(
        `Most rows to return (default ${DEFAULT_LIMIT}). At most ${count(MAX_LIMIT)} rows come back per call; a larger limit is lowered to ${count(MAX_LIMIT)} and the notice says so. Put LIMIT and OFFSET in the SQL to page past them.`,
      ),
  }),

  output: z.object({
    columns: z
      .array(z.string())
      .describe(
        'Result column names, in SELECT order. A name the SELECT repeats comes back suffixed (deaths, deaths_1), so each keys its own value in rows.',
      ),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows, keyed by column name, in the order the SELECT produced them. DOUBLE and INTEGER values are numbers, except that a DOUBLE NaN, Infinity, or -Infinity comes back as that string; BIGINT, DECIMAL, and text values are strings; null where the value is null.',
      ),
    rowCount: z.number().describe('Rows returned in this response.'),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the SELECT produced more rows than were returned.'),
    shown: z.number().optional().describe('Rows returned, present when truncated is set.'),
    cap: z
      .number()
      .optional()
      .describe(
        `The row limit that ended the response — limit, lowered to ${count(MAX_LIMIT)} when set higher. Present when truncated is set.`,
      ),
    notice: z
      .string()
      .optional()
      .describe(
        `Present when more rows remain than were returned, saying how to reach them, or when limit was lowered to ${count(MAX_LIMIT)}.`,
      ),
  },

  async handler(input, ctx) {
    const instance = await liveCanvas(ctx);
    if (!instance) {
      throw ctx.fail(
        'missing_table',
        'Nothing is staged on this server yet, so the SELECT has no table to read.',
      );
    }

    const limit = Math.min(input.limit, MAX_LIMIT);
    const sql = statementBody(input.sql);

    let result: QueryResult;
    try {
      result = await instance.query(replyQuery(sql, limit), {
        rowLimit: limit,
        signal: ctx.signal,
      });
    } catch (err) {
      /**
       * `missing_table` arrives from the canvas with a hint of its own, which would outrank the
       * declared recovery; re-raised through `ctx.fail`, the declared one names this server's
       * tools. Every other canvas rejection keeps its own reason and hint.
       */
      if (err instanceof McpError && err.data?.reason === 'missing_table') {
        const tableName = typeof err.data.tableName === 'string' ? err.data.tableName : undefined;
        /**
         * Inside the wrapper's `FROM ( … )`, a statement that opens with a word such as TRUNCATE
         * or CHECKPOINT reads as a table of that name, so the engine reports it missing. It is a
         * statement other than a SELECT, never a table to stage again.
         */
        const opening = leadingWord(sql);
        if (tableName && opening?.toLowerCase() === tableName.toLowerCase()) {
          throw ctx.fail(
            'invalid_sql',
            `The SQL opens with ${opening}, a statement other than a SELECT; only one read-only SELECT runs over the staged tables.`,
            undefined,
            { cause: err },
          );
        }
        throw ctx.fail(
          'missing_table',
          `${tableName ? `Table ${tableName}` : 'A table the SELECT names'} is not staged on this server.`,
          tableName ? { tableName } : undefined,
          { cause: err },
        );
      }
      throw err;
    }

    const columns = result.columns.slice(0, -2);
    const [rowsKey, bytesKey] = result.columns.slice(-2) as [string, string];
    // Every row carries both measurements as numbers; an empty result yields no row at all.
    const [first] = result.rows;
    const replyBytes = first === undefined ? 0 : Number(first[bytesKey]);
    const truncated = first !== undefined && Number(first[rowsKey]) > limit;
    if (replyBytes > MAX_REPLY_BYTES) {
      throw ctx.fail(
        'result_too_large',
        `The rows this SELECT returns at limit ${limit} measure ${count(replyBytes)} bytes as JSON, past the ${count(MAX_REPLY_BYTES)}-byte ceiling on one reply.`,
        { replyBytes, maxReplyBytes: MAX_REPLY_BYTES },
      );
    }
    /**
     * The engine builds each row by assigning its keys to a plain object, which drops a
     * `__proto__` key, and the reply's row schema drops one too, so such a column would be
     * listed with its value missing from every row.
     */
    if (columns.includes('__proto__')) {
      throw ctx.fail(
        'reserved_column_name',
        'The SELECT returns a column named __proto__, which a reply row cannot hold as a key.',
      );
    }
    const rows = result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== rowsKey && key !== bytesKey),
      ),
    );

    const lowered = input.limit > MAX_LIMIT;
    const loweredNotice = lowered
      ? `limit=${input.limit} was lowered to ${MAX_LIMIT}, the most rows one call returns.`
      : undefined;
    /** `enrich.truncated()` writes `notice` too, and the last writer wins, so it carries both. */
    if (truncated) {
      ctx.enrich.truncated({
        shown: rows.length,
        cap: limit,
        guidance: [
          `Showing the first ${count(rows.length)} rows; more remain.`,
          loweredNotice,
          'Aggregate or filter in the SQL, or add LIMIT and OFFSET to page through the rest.',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } else if (loweredNotice) {
      ctx.enrich.notice(loweredNotice);
    }

    ctx.log.info('Staged tables queried', { rowCount: rows.length, replyBytes, truncated });
    return { columns, rows, rowCount: rows.length };
  },

  format: (result) => {
    const heading = `**${result.rowCount} rows**`;
    if (result.rows.length === 0) {
      return [
        {
          type: 'text',
          text: `${heading}\n\nColumns: ${result.columns.map(markdownCodeSpan).join(', ')}`,
        },
      ];
    }
    const lossless =
      result.columns.every(fitsTableCell) &&
      result.rows.every((row) => result.columns.every((column) => fitsTableCell(row[column])));
    if (!lossless) {
      /** A cell a table would alter (a line break, an object) — the whole result as JSON. */
      const json = JSON.stringify({ columns: result.columns, rows: result.rows });
      return [
        { type: 'text', text: `${heading}\n\n${markdown().codeBlock(json, 'json').build()}` },
      ];
    }
    const cell = (value: unknown) => (value === null ? '' : escapeTableCell(String(value)));
    const lines = [
      heading,
      '',
      `| ${result.columns.map(cell).join(' | ')} |`,
      `| ${result.columns.map(() => '---').join(' | ')} |`,
      ...result.rows.map((row) => `| ${result.columns.map((c) => cell(row[c])).join(' | ')} |`),
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
