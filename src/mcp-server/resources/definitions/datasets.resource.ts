/**
 * @fileoverview Resource listing the top 50 CDC datasets by popularity for orientation.
 * @module mcp-server/resources/definitions/datasets
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

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
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Socrata catalog API returned HTTP 400 (unexpected for this fixed orientation request, which takes no caller input).',
      recovery:
        'Retry shortly; if it persists, browse the catalog with cdc_discover_datasets instead.',
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
    let result: DiscoverResult;
    try {
      result = await service.discover({ limit: 50 }, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

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
