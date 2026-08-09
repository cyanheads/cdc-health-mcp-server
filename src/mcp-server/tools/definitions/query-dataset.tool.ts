/**
 * @fileoverview Tool to execute SoQL queries against any CDC dataset.
 * @module mcp-server/tools/definitions/query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import { CDC_SOCRATA_DOMAINS, type QueryResult } from '@/services/socrata/types.js';
import { escapeTableCell } from '@/utils/markdown.js';

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
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Socrata returned 403 — typically an ID naming a chart, map, story, file, or external link rather than a tabular dataset.',
      recovery:
        'Confirm the ID with cdc_get_dataset_schema, then query one whose schema lists columns; retrying this ID returns the same refusal.',
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
      when: 'Socrata data API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a brief delay; data.cdc.gov may be temporarily unavailable.',
    },
  ],

  input: z.object({
    domain: z
      .enum(CDC_SOCRATA_DOMAINS)
      .default('data.cdc.gov')
      .describe(
        'CDC Socrata host to query. "data.cdc.gov" (default) and "chronicdata.cdc.gov" front the same catalog, so a four-by-four ID returns the same rows from either and the default works whichever host the dataset was found on.',
      ),
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
        'SoQL WHERE clause. Strings must be single-quoted: "state=\'California\' AND year=2020". If a column name matches a SoQL keyword (group, select, where, order, limit, offset, having, search), wrap it in backticks: "`group`=\'By Year\'".',
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
    offset: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .default(0)
      .describe('Row offset for pagination (max 1,000,000).'),
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
  // debugging and reproducibility), capped-list disclosure, and a recovery notice when
  // nothing matched. Reaches structuredContent AND content[] automatically — no format() entry.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The SoQL clauses sent to Socrata, as `$clause=value` pairs joined by "&". Values read exactly as they were supplied — not URL-encoded — so a clause can be copied back into the matching parameter of another call.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the result row count hit the requested limit and may be incomplete.'),
    shown: z.number().optional().describe('Number of rows returned in this response.'),
    cap: z.number().optional().describe('The requested limit that bounded this response.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no rows matched or results were truncated — how to verify filters, paginate, or broaden the query.',
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
      ctx.enrich.truncated({
        shown: result.rowCount,
        cap: input.limit,
        guidance: `Results may be truncated — rowCount equals the requested limit (${input.limit}). Use the offset parameter to paginate or increase limit (max ${MAX_LIMIT}).`,
      });
    }

    ctx.log.info('Query executed', {
      domain: input.domain,
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

    // Socrata rows are sparse: fields selected by the caller can be omitted on early
    // rows and appear only later. Build the column set from the union of keys across
    // all rows (first-seen order) so late-appearing fields still render in content[].
    const columns = [...new Set(result.rows.flatMap((r) => Object.keys(r)))];
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
        return escapeTableCell(s);
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
