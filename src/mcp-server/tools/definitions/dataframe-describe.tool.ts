/**
 * @fileoverview Tool to list the WONDER tables cdc_query_wonder staged on this server's
 * DataCanvas, with their row counts, columns, and expiry.
 * @module mcp-server/tools/definitions/dataframe-describe
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { liveCanvas } from '@/services/canvas-accessor.js';
import { MAX_STAGED_TABLES } from '@/services/wonder/staged-table.js';
import { markdownCodeSpan } from '@/utils/markdown.js';

const ColumnSchema = z
  .object({
    name: z.string().describe('Column name, as SQL references it.'),
    type: z
      .string()
      .describe(
        'Column type: VARCHAR for dimension labels, cause_code, and the _status columns; INTEGER for cause_level; DOUBLE for deaths, population, rates, and interval bounds.',
      ),
  })
  .describe('One column of a staged table.');

const TableSchema = z
  .object({
    name: z.string().describe('Table name to use in cdc_dataframe_query SQL.'),
    rowCount: z
      .number()
      .describe('Rows the table holds — every row of the WONDER table it was staged from.'),
    expiresAt: z
      .string()
      .optional()
      .describe(
        `When the table is dropped if no query reads it (ISO 8601), or sooner once ${MAX_STAGED_TABLES} tables are staged and it expires before the rest. Each cdc_dataframe_query that reads it moves this an hour past the read.`,
      ),
    columns: z.array(ColumnSchema).describe('Columns in table order.'),
  })
  .describe('One staged table.');

export const dataframeDescribe = tool('cdc_dataframe_describe', {
  title: 'Describe Staged WONDER Tables',
  description: `List the tables cdc_query_wonder has staged on this server for SQL, each with its row count, its columns and their types, and when it is dropped. cdc_query_wonder stages the whole WONDER table when a call at offset 0 leaves rows past the page it returns, and names it in stagedTable. A staged table holds the columns of the inline rows in CDC's row order, then a <measure>_status column for each measure — the token CDC returned in place of the value ("Suppressed", "Unreliable", "Not Applicable"), null where the value is a number. Dimension columns are text, so a year compares as '2024'. Pass table to describe one table. A table is dropped an hour after the last query that read it, or earlier, earliest-expiring first, once ${MAX_STAGED_TABLES} are staged, and the list can include tables other sessions on this server staged.`,
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: `table names a table that is not staged: it was dropped after an hour unread or earlier to make room once ${MAX_STAGED_TABLES} were staged, never staged, or mistyped.`,
      recovery:
        'Call cdc_dataframe_describe without table to list the tables staged now, or call cdc_query_wonder again at offset 0 to stage the table afresh and use the name it returns.',
    },
  ],

  input: z.object({
    table: z
      .string()
      .regex(CANVAS_IDENTIFIER_REGEX)
      .optional()
      .describe(
        'A table name as cdc_query_wonder returned it in stagedTable, e.g. "wonder_k3x9q2m7ab". Omit to list every staged table.',
      ),
  }),

  output: z.object({
    tables: z
      .array(TableSchema)
      .describe(
        'The staged tables, by name — the one named by table when it is set. Empty when nothing is staged.',
      ),
  }),

  enrichment: {
    notice: z.string().optional().describe('How to stage a table, when none is staged.'),
  },

  async handler(input, ctx) {
    const instance = await liveCanvas(ctx);
    const described = instance
      ? await instance.describe({
          ...(input.table ? { tableName: input.table } : {}),
          signal: ctx.signal,
        })
      : [];

    if (input.table && described.length === 0) {
      throw ctx.fail('missing_table', `No table named ${input.table} is staged on this server.`, {
        tableName: input.table,
      });
    }
    if (described.length === 0) {
      ctx.enrich.notice(
        'Nothing is staged. cdc_query_wonder stages the whole WONDER table when a call at offset 0 leaves rows past the page it returns — any grouping larger than the page — and names the table in stagedTable.',
      );
    }

    ctx.log.info('Staged tables described', { tableCount: described.length });
    return {
      tables: described.map((table) => ({
        name: table.name,
        rowCount: table.rowCount,
        ...(table.expiresAt ? { expiresAt: table.expiresAt } : {}),
        columns: table.columns.map(({ name, type }) => ({ name, type })),
      })),
    };
  },

  format: (result) => {
    if (result.tables.length === 0) return [{ type: 'text', text: '**No staged tables.**' }];
    const lines: string[] = [];
    for (const table of result.tables) {
      lines.push(
        `**${markdownCodeSpan(table.name)}** — ${table.rowCount} rows${table.expiresAt ? `, dropped at ${table.expiresAt} unless read` : ''}`,
        ...table.columns.map((column) => `- ${markdownCodeSpan(column.name)} ${column.type}`),
        '',
      );
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
