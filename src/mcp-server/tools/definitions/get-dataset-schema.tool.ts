/**
 * @fileoverview Tool to fetch the full column schema for a CDC dataset.
 * @module mcp-server/tools/definitions/get-dataset-schema
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import { CDC_SOCRATA_DOMAINS, type DatasetMetadata } from '@/services/socrata/types.js';
import { escapeTableCell } from '@/utils/markdown.js';

/**
 * Columns returned per call when the caller names no window. Catalog schemas run from 3 to
 * 322 columns; at 100 every dataset in the ordinary range arrives whole, while the widest
 * outlier's column payload drops by roughly two thirds. Descriptions carry the field
 * semantics needed to write a correct query, so the count of columns returned is the knob —
 * never their content.
 */
const DEFAULT_COLUMN_LIMIT = 100;
/** Ceiling on `column_limit`, comfortably above the widest schema in the catalog. */
const MAX_COLUMN_LIMIT = 500;

export const getDatasetSchema = tool('cdc_get_dataset_schema', {
  description:
    'Fetch the column schema for a CDC dataset — names, data types, descriptions, row count, and last-updated timestamp. Returns the first 100 columns by default; wide datasets continue via column_offset. Get dataset IDs from cdc_discover_datasets.',
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
      reason: 'not_queryable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID names a catalog asset with no columns — a chart, map, story, file, or external link rather than a tabular dataset.',
      recovery:
        'Pick an ID from cdc_discover_datasets whose columnCount is above zero; those are the entries cdc_query_dataset can read.',
    },
    {
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Socrata returned 403 — the asset is not readable through this endpoint or access is restricted.',
      recovery:
        'Choose a different dataset ID from cdc_discover_datasets; repeating this request returns the same refusal.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Socrata rejected the metadata request with a 400.',
      recovery:
        'Read the returned message for the rejected part, then re-fetch the ID from cdc_discover_datasets and retry.',
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
      when: 'Socrata metadata API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a brief delay; data.cdc.gov may be temporarily unavailable.',
    },
  ],

  input: z.object({
    domain: z
      .enum(CDC_SOCRATA_DOMAINS)
      .default('data.cdc.gov')
      .describe(
        'CDC Socrata host to fetch the dataset from. "data.cdc.gov" (default) and "chronicdata.cdc.gov" front the same catalog, so a four-by-four ID resolves on either and the default works whichever host the dataset was found on.',
      ),
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe(
        'Four-by-four dataset identifier (e.g., "bi63-dtpu"). Obtain from cdc_discover_datasets.',
      ),
    column_limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_COLUMN_LIMIT)
      .default(DEFAULT_COLUMN_LIMIT)
      .describe(
        `Columns to return in this call (default ${DEFAULT_COLUMN_LIMIT}, max ${MAX_COLUMN_LIMIT}). Every dataset under the default arrives whole; past it the response reports totalCount and a nextOffset to pass back as column_offset. Raise this to pull a wide schema in one call.`,
      ),
    column_offset: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(0)
      .describe(
        'Index of the first column to return, for continuing past a previous call (default 0). Columns keep the order the dataset declares, so column_offset plus column_limit walks the schema without gaps or repeats. An offset at or past the column count returns an empty window rather than an error.',
      ),
  }),

  output: z.object({
    name: z
      .string()
      .describe(
        'Dataset display name from the catalog (e.g., "Provisional COVID-19 Deaths by Sex and Age").',
      ),
    description: z.string().optional().describe('Dataset description when provided.'),
    rowCount: z
      .number()
      .optional()
      .describe('Total number of rows when reported by upstream; omitted when unknown.'),
    updatedAt: z.string().optional().describe('Last data update timestamp when provided.'),
    columns: z
      .array(
        z
          .object({
            fieldName: z.string().describe('Column field name (use in SoQL queries).'),
            dataType: z.string().describe('Column data type (text, number, calendar_date, etc.).'),
            description: z.string().optional().describe('Column description when provided.'),
          })
          .describe('A single column in the dataset schema.'),
      )
      .describe(
        'The requested window of dataset columns, with full types and descriptions. Bounded by column_limit/column_offset; the enrichment fields say how the window sits in the whole schema.',
      ),
  }),

  // Agent-facing window context: the dataset's true column total, whether this response is
  // a subset of it, and where to resume. Reaches structuredContent AND content[]
  // automatically — no format() entry needed or allowed.
  enrichment: {
    totalCount: z
      .number()
      .describe('Total columns in the dataset schema, before column_limit/column_offset.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the returned columns are a subset of the schema. Absent means every column of the dataset is in this response.',
      ),
    shown: z.number().optional().describe('Number of columns returned in this response.'),
    cap: z.number().optional().describe('The column_limit that bounded this response.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Value to pass as column_offset on the next call to continue after the last column returned. Present only when columns remain beyond this window.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the response is a subset of the schema — which columns it covers, how to reach the rest, or that column_offset ran past the end.',
      ),
  },

  async handler(input, ctx) {
    const service = getSocrataService();
    let metadata: DatasetMetadata;
    try {
      metadata = await service.getMetadata(input.datasetId, ctx.signal, input.domain);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

    /**
     * The metadata endpoint answers 200 for every catalog asset, including charts, maps,
     * stories, files, and external links. Those come back with an empty `columns` array —
     * the one signal that lines up with what `/resource/{id}.json` will actually serve.
     * `resource.type` does not: `filter` assets carry real columns and query successfully.
     */
    if (metadata.columns.length === 0) {
      throw ctx.fail(
        'not_queryable',
        `Dataset ${input.datasetId} ("${metadata.name}") has no columns. The ID names a non-tabular catalog asset, so there is no schema to return and cdc_query_dataset cannot read it.`,
        { ...ctx.recoveryFor('not_queryable') },
      );
    }

    const total = metadata.columns.length;
    const columns = metadata.columns.slice(
      input.column_offset,
      input.column_offset + input.column_limit,
    );
    const consumed = input.column_offset + columns.length;

    ctx.enrich.total(total);

    if (columns.length < total) {
      /**
       * `enrich.truncated()` writes `notice` itself and last-wins over any other notice
       * call, so the three window cases compose into the single `guidance` string.
       */
      const guidance =
        input.column_offset >= total
          ? `column_offset ${input.column_offset} is past the end of this schema, which holds ${total} columns. Lower column_offset below ${total} to see columns.`
          : consumed < total
            ? `Showing columns ${input.column_offset + 1}–${consumed} of ${total}. Call again with column_offset=${consumed} for the next window, or raise column_limit (max ${MAX_COLUMN_LIMIT}) to pull more per call.`
            : `Showing columns ${input.column_offset + 1}–${consumed} of ${total} — the end of the schema. The earlier columns are at lower column_offset values.`;
      ctx.enrich.truncated({ shown: columns.length, cap: input.column_limit, guidance });
      if (consumed < total) ctx.enrich({ nextOffset: consumed });
    }

    ctx.log.info('Schema retrieved', {
      domain: input.domain,
      datasetId: input.datasetId,
      name: metadata.name,
      columnCount: total,
      columnsShown: columns.length,
      columnOffset: input.column_offset,
      rowCount: metadata.rowCount,
    });

    return { ...metadata, columns };
  },

  format: (result) => {
    const lines = [`## ${result.name}`, ''];
    if (result.description) lines.push(result.description, '');
    const rows = typeof result.rowCount === 'number' ? result.rowCount.toLocaleString() : '—';
    lines.push(
      `**Rows:** ${rows} | **Updated:** ${result.updatedAt ?? '—'}`,
      '',
      '| Column | Type | Description |',
      '|:-------|:-----|:------------|',
    );

    for (const col of result.columns) {
      const description = escapeTableCell(col.description ?? '') || '—';
      lines.push(
        `| \`${escapeTableCell(col.fieldName)}\` | ${escapeTableCell(col.dataType)} | ${description} |`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
