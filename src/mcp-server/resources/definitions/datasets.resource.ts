/**
 * @fileoverview Resource listing the top 50 CDC datasets by popularity for orientation.
 * @module mcp-server/resources/definitions/datasets
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const datasetsResource = resource('cdc://datasets', {
  name: 'CDC Dataset Catalog',
  description:
    'Top 50 CDC datasets by popularity with names, categories, and update timestamps. Provides an overview of the CDC data landscape for orientation. Use cdc_discover_datasets for full catalog search with filtering and pagination.',
  mimeType: 'application/json',

  errors: [
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
      when: 'Socrata catalog API returned a non-success status outside of 429.',
      retryable: true,
      recovery: 'Retry after a brief delay; the catalog may be temporarily unavailable.',
    },
  ],

  list: async () => ({
    resources: [
      {
        uri: 'cdc://datasets',
        name: 'CDC Dataset Catalog',
        mimeType: 'application/json',
      },
    ],
  }),

  async handler(_params, ctx) {
    const service = getSocrataService();
    const result = await service.discover({ limit: 50 }, ctx.signal);

    ctx.log.info('Datasets resource accessed', { totalCount: result.totalCount });

    return {
      datasets: result.datasets.map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        updatedAt: d.updatedAt,
      })),
      totalCount: result.totalCount,
    };
  },
});
