/**
 * @fileoverview Resource listing the 50 most-viewed CDC catalog entries for orientation.
 * The catalog mixes charts, stories, and filters in with the datasets, so each entry carries
 * its assetType and columnCount — a columnCount of 0 marks an ID the other tools cannot read.
 * @module mcp-server/resources/definitions/datasets
 */

import { resource } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

export const datasetsResource = resource('cdc://datasets', {
  name: 'CDC Dataset Catalog',
  description:
    'Top 50 CDC catalog entries by popularity with names, categories, asset types, column counts, and update timestamps. Provides an overview of the CDC data landscape for orientation; an entry whose columnCount is 0 is not tabular and yields no data from cdc_get_dataset_schema or cdc_query_dataset. Use cdc_discover_datasets for full catalog search with filtering and pagination.',
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
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Socrata returned 404 for the catalog endpoint itself — the Discovery API address is wrong or the service moved.',
      recovery:
        'Check that CDC_CATALOG_URL still points at the Socrata Discovery API; the default is https://api.us.socrata.com/api/catalog/v1.',
    },
    {
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Socrata returned 403 — the catalog refused this request rather than failing to serve it.',
      recovery:
        'Do not retry; browse the catalog with cdc_discover_datasets, which takes explicit search parameters.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Socrata catalog API returned a 5xx server error.',
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

    /**
     * This page is drawn from the same catalog as cdc_discover_datasets, so it carries
     * charts, stories, and filters alongside datasets. It has to label them the same way:
     * a reader picking an ID off this list otherwise reaches cdc_get_dataset_schema before
     * anything says the asset has no schema. `columnCount` is the queryability test and
     * `assetType` is only the catalog's label — a `filter` entry has columns and queries.
     */
    return {
      datasets: result.datasets.map((d) => ({
        id: d.id,
        name: d.name,
        assetType: d.assetType,
        category: d.category,
        columnCount: d.columnNames?.length,
        updatedAt: d.updatedAt,
      })),
      totalCount: result.totalCount,
    };
  },
});
