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
    description: z.string().describe('Dataset description.'),
    rowCount: z.number().describe('Total number of rows in the dataset.'),
    updatedAt: z.string().describe('Last data update timestamp.'),
    columns: z
      .array(
        z.object({
          fieldName: z.string().describe('Column field name (use in SoQL queries).'),
          dataType: z.string().describe('Column data type (text, number, calendar_date, etc.).'),
          description: z.string().describe('Column description.'),
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
    const lines = [
      `## ${result.name}`,
      '',
      result.description,
      '',
      `**Rows:** ${result.rowCount.toLocaleString()} | **Updated:** ${result.updatedAt}`,
      '',
      '| Column | Type | Description |',
      '|:-------|:-----|:------------|',
    ];

    for (const col of result.columns) {
      lines.push(`| \`${col.fieldName}\` | ${col.dataType} | ${col.description || '—'} |`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
