/**
 * @fileoverview Tool to fetch the full column schema for a CDC dataset.
 * @module mcp-server/tools/definitions/get-dataset-schema
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import { CDC_SOCRATA_DOMAINS, type DatasetMetadata } from '@/services/socrata/types.js';
import { escapeTableCell } from '@/utils/markdown.js';

export const getDatasetSchema = tool('cdc_get_dataset_schema', {
  description:
    'Fetch the full column schema for a CDC dataset — names, data types, descriptions, row count, and last-updated timestamp. Get dataset IDs from cdc_discover_datasets.',
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
        'CDC Socrata portal hosting the dataset. Use the same portal you found the dataset on via cdc_discover_datasets: "data.cdc.gov" (default) or "chronicdata.cdc.gov".',
      ),
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe(
        'Four-by-four dataset identifier (e.g., "bi63-dtpu"). Obtain from cdc_discover_datasets.',
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
      .describe('Dataset columns with types and descriptions.'),
  }),

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

    ctx.log.info('Schema retrieved', {
      domain: input.domain,
      datasetId: input.datasetId,
      name: metadata.name,
      columnCount: metadata.columns.length,
      rowCount: metadata.rowCount,
    });

    return metadata;
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
