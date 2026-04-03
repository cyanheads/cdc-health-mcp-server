/**
 * @fileoverview Resource for fetching individual dataset metadata and schema by ID.
 * @module mcp-server/resources/definitions/dataset-detail
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const datasetDetailResource = resource('cdc://datasets/{datasetId}', {
  name: 'CDC Dataset Detail',
  description:
    'Dataset metadata and column schema for a specific CDC dataset. Equivalent to cdc_get_dataset_schema — useful for injecting dataset context directly.',
  mimeType: 'application/json',
  params: z.object({
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe('Four-by-four dataset identifier (e.g., "bi63-dtpu").'),
  }),

  async handler(params, ctx) {
    const service = getSocrataService();
    const metadata = await service.getMetadata(params.datasetId, ctx.signal);

    ctx.log.info('Dataset detail resource accessed', {
      datasetId: params.datasetId,
      name: metadata.name,
    });

    return metadata;
  },
});
