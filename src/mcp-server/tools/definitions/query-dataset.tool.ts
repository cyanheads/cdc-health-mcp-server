/**
 * @fileoverview Tool to execute SoQL queries against any CDC dataset.
 * @module mcp-server/tools/definitions/query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

const MAX_LIMIT = 5000;

export const queryDataset = tool('cdc_query_dataset', {
  description: `Execute a SoQL query against any CDC dataset. Supports filtering, aggregation, sorting, full-text search, and field selection. Use cdc_discover_datasets to find dataset IDs and cdc_get_dataset_schema to inspect columns before querying.\n\nTip — enumerate column values: use select: "{column}, count(*) as count", group: "{column}", order: "count DESC" to see distinct values.`,
  annotations: { readOnlyHint: true },

  input: z.object({
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe('Four-by-four dataset identifier (e.g., "bi63-dtpu").'),
    search: z
      .string()
      .optional()
      .describe(
        'Full-text search across all text columns (maps to $q). For precise filtering use where instead.',
      ),
    select: z
      .string()
      .optional()
      .describe(
        'SoQL SELECT clause. Column names, aliases, aggregates: "state, sum(deaths) as total_deaths". Omit for all columns.',
      ),
    where: z
      .string()
      .optional()
      .describe(
        'SoQL WHERE clause. Strings must be single-quoted: "state=\'California\' AND year=2020".',
      ),
    group: z
      .string()
      .optional()
      .describe('SoQL GROUP BY clause. Requires aggregate functions in select.'),
    having: z.string().optional().describe('SoQL HAVING clause. Filters aggregated results.'),
    order: z
      .string()
      .optional()
      .describe('SoQL ORDER BY clause. Field name with optional ASC/DESC: "total_deaths DESC".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(1000)
      .describe(`Max rows to return (default 1000, max ${MAX_LIMIT}).`),
    offset: z.number().int().min(0).default(0).describe('Row offset for pagination.'),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.string().describe('Field value')))
      .describe(
        'Result rows with requested fields. All values are strings — parse based on column type from schema.',
      ),
    rowCount: z.number().describe('Number of rows returned in this response.'),
    query: z.string().describe('Assembled SoQL query string (for debugging).'),
  }),

  async handler(input, ctx) {
    if (!input.search && !input.where && !input.select) {
      throw new Error('At least one of search, where, or select must be provided.');
    }

    const service = getSocrataService();
    const result = await service.query(
      {
        datasetId: input.datasetId,
        search: input.search,
        select: input.select,
        where: input.where,
        group: input.group,
        having: input.having,
        order: input.order,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.signal,
    );

    ctx.log.info('Query executed', {
      datasetId: input.datasetId,
      rowCount: result.rowCount,
      query: result.query,
    });

    return result;
  },

  format: (result) => {
    if (result.rows.length === 0 || !result.rows[0]) {
      return [{ type: 'text', text: `No rows returned.\n\n**Query:** \`${result.query}\`` }];
    }

    const columns = Object.keys(result.rows[0]);
    const lines = [
      `**${result.rowCount} rows returned**`,
      '',
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
    ];

    const displayRows = result.rows.slice(0, 50);
    for (const row of displayRows) {
      const cells = columns.map((c) => (row[c] ?? '').replaceAll('|', '\\|'));
      lines.push(`| ${cells.join(' | ')} |`);
    }

    if (result.rows.length > 50) {
      lines.push('', `*...and ${result.rows.length - 50} more rows (truncated in display)*`);
    }

    lines.push('', `**Query:** \`${result.query}\``);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
