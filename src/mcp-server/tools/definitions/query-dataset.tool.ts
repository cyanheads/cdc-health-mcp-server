/**
 * @fileoverview Tool to execute SoQL queries against any CDC dataset.
 * @module mcp-server/tools/definitions/query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { QueryResult } from '@/services/socrata/types.js';

const MAX_LIMIT = 5000;

export const queryDataset = tool('cdc_query_dataset', {
  description:
    'Execute a SoQL query against any CDC dataset. Supports filtering, aggregation, sorting, full-text search, and field selection. Use cdc_discover_datasets to find dataset IDs and cdc_get_dataset_schema to inspect columns before querying.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset ID does not exist or has been retired.',
      recovery:
        'Search again with cdc_discover_datasets to find a current ID for the topic of interest.',
    },
    {
      reason: 'no_such_column',
      code: JsonRpcErrorCode.ValidationError,
      when: 'WHERE/SELECT/GROUP/ORDER references a column that does not exist on this dataset.',
      recovery:
        'Call cdc_get_dataset_schema for this dataset and rewrite the query using actual column names.',
    },
    {
      reason: 'type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Filter value type does not match the column data type (e.g., quoting a number).',
      recovery:
        'Inspect column types via cdc_get_dataset_schema and adjust filter literals to match (numbers unquoted, strings single-quoted).',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Socrata rejected the SoQL query for other syntax or semantic reasons.',
      recovery:
        'Read the error message for the specific clause and consult the dataset schema before retrying.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Socrata API returns 429 Too Many Requests.',
      retryable: true,
      recovery: 'Retry after a brief delay; the request was rate-limited.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Socrata data API returned a non-success status outside of 404, 429, or validation errors.',
      retryable: true,
      recovery: 'Retry after a brief delay; data.cdc.gov may be temporarily unavailable.',
    },
  ],

  input: z.object({
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe(
        'Four-by-four dataset identifier (e.g., "bi63-dtpu"). Obtain from cdc_discover_datasets.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Full-text search across all text columns. For precise filtering use the where parameter instead.',
      ),
    select: z
      .string()
      .optional()
      .describe(
        'SoQL SELECT clause — column names, aliases, or aggregates: "state, sum(deaths) as total_deaths". Omit for all columns. To enumerate distinct values of a column, set select to "{column}, count(*) as count" with group="{column}" and order="count DESC".',
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
      .default(100)
      .describe(`Max rows to return (default 100, max ${MAX_LIMIT}).`),
    offset: z.number().int().min(0).default(0).describe('Row offset for pagination.'),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows with requested fields. Most values are strings (including numbers/dates); geo columns return GeoJSON objects.',
      ),
    rowCount: z.number().describe('Number of rows returned in this response.'),
  }),

  // Agent-facing result-set context: the assembled SoQL query sent to Socrata (for
  // debugging and reproducibility) and a recovery notice when nothing matched.
  // Reaches structuredContent AND content[] automatically — no format() entry needed.
  enrichment: {
    effectiveQuery: z.string().describe('Assembled SoQL query string sent to the Socrata API.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no rows matched — suggests how to verify filter values or broaden the WHERE clause.',
      ),
  },

  async handler(input, ctx) {
    const service = getSocrataService();
    let result: QueryResult;
    try {
      result = await service.query(input, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

    ctx.enrich({ effectiveQuery: result.query });

    if (result.rows.length === 0) {
      ctx.enrich.notice(
        'No rows matched the query. Verify string values are spelled exactly as stored (check with a GROUP BY enumeration), confirm numeric/date filters match the column type from the schema, or broaden the WHERE clause.',
      );
    } else if (result.rowCount === input.limit) {
      ctx.enrich.notice(
        `Results may be truncated — rowCount equals the requested limit (${input.limit}). Use the offset parameter to paginate or increase limit (max ${MAX_LIMIT}).`,
      );
    }

    ctx.log.info('Query executed', {
      datasetId: input.datasetId,
      rowCount: result.rowCount,
      query: result.query,
    });

    return { rows: result.rows, rowCount: result.rowCount };
  },

  format: (result) => {
    if (!result.rows[0]) {
      return [
        {
          type: 'text',
          text: [
            'No rows matched the query.',
            '',
            'Suggestions:',
            '- Verify string values are spelled exactly as stored (check with a GROUP BY enumeration)',
            '- Check that numeric/date filters match the column type from the schema',
            '- Broaden the WHERE clause or remove filters to confirm data exists',
          ].join('\n'),
        },
      ];
    }

    const columns = Object.keys(result.rows[0]);
    const lines = [
      `**${result.rowCount} rows returned**`,
      '',
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
    ];

    for (const row of result.rows) {
      const cells = columns.map((c) => {
        const v = row[c];
        const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
        return s.replaceAll('|', '\\|').replaceAll('\n', ' ');
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }

    lines.push(
      '',
      'Tip: Use cdc_get_dataset_schema to inspect column names and types if filter results are unexpected.',
    );

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
