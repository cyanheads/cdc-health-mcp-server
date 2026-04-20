/**
 * @fileoverview Tool to fetch the full column schema for a CDC dataset.
 * @module mcp-server/tools/definitions/get-dataset-schema
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const getDatasetSchema = tool('cdc_get_dataset_schema', {
  description:
    'Fetch the full column schema for a CDC dataset — names, data types, descriptions, row count, and last-updated timestamp. Essential before writing SoQL queries against unfamiliar datasets.',
  annotations: { readOnlyHint: true },

  input: z.object({
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe(
        'Four-by-four dataset identifier (e.g., "bi63-dtpu"). Obtain from cdc_discover_datasets.',
      ),
  }),

  output: z.object({
    name: z.string().describe('Dataset name.'),
    description: z.string().optional().describe('Dataset description when provided.'),
    rowCount: z
      .number()
      .optional()
      .describe('Total number of rows when reported by upstream; omitted when unknown.'),
    updatedAt: z.string().optional().describe('Last data update timestamp when provided.'),
    columns: z
      .array(
        z.object({
          fieldName: z.string().describe('Column field name (use in SoQL queries).'),
          dataType: z.string().describe('Column data type (text, number, calendar_date, etc.).'),
          description: z.string().optional().describe('Column description when provided.'),
        }),
      )
      .describe('Dataset columns with types and descriptions.'),
  }),

  async handler(input, ctx) {
    const service = getSocrataService();
    const metadata = await service.getMetadata(input.datasetId, ctx.signal);

    ctx.log.info('Schema retrieved', {
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
      lines.push(`| \`${col.fieldName}\` | ${col.dataType} | ${col.description || '—'} |`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
