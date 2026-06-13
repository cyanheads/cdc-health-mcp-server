/**
 * @fileoverview Resource for fetching individual dataset metadata and schema by ID.
 * @module mcp-server/resources/definitions/dataset-detail
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';

export const datasetDetailResource = resource('cdc://datasets/{datasetId}', {
  name: 'CDC Dataset Detail',
  description:
    'Dataset metadata and column schema for a specific CDC dataset, addressable by URI. Same payload as cdc_get_dataset_schema.',
  mimeType: 'application/json',

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset ID does not exist or has been retired.',
      recovery:
        'Search again with cdc_discover_datasets to find a current ID for the topic of interest.',
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
      when: 'Socrata metadata API returned a non-success status outside of 404/429.',
      retryable: true,
      recovery: 'Retry after a brief delay; data.cdc.gov may be temporarily unavailable.',
    },
  ],

  list: async () => ({
    resources: [
      {
        uri: 'cdc://datasets/bi63-dtpu',
        name: 'NCHS - Leading Causes of Death: United States',
        mimeType: 'application/json',
      },
      {
        uri: 'cdc://datasets/9bhg-hcku',
        name: 'Provisional COVID-19 Deaths by Sex and Age',
        mimeType: 'application/json',
      },
    ],
  }),

  params: z.object({
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe('Four-by-four dataset identifier (e.g., "bi63-dtpu").'),
  }),

  async handler(params, ctx) {
    const service = getSocrataService();
    let metadata: DatasetMetadata;
    try {
      metadata = await service.getMetadata(params.datasetId, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

    ctx.log.info('Dataset detail resource accessed', {
      datasetId: params.datasetId,
      name: metadata.name,
    });

    return metadata;
  },
});
