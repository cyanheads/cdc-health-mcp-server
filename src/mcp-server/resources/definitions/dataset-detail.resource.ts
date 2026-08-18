/**
 * @fileoverview Resource for fetching individual dataset metadata and schema by ID.
 * @module mcp-server/resources/definitions/dataset-detail
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';

/**
 * Columns carried per read, matching `cdc_get_dataset_schema`'s default window so both
 * surfaces answer with the same shape.
 *
 * The resource takes no selector. RFC 6570 query expansion (`{?column_limit,column_offset}`)
 * expresses such a URI, but the MCP SDK's `UriTemplate.match` compiles query variables into
 * *required* pattern segments in declared order: a template carrying them stops matching the
 * bare `cdc://datasets/{datasetId}` form every client already holds, and a URI supplying only
 * one of the two matches nothing at all. Bounding the read and naming the tool for the
 * remainder keeps the existing URI working with no unbounded path left to the same data.
 */
const COLUMN_WINDOW = 100;

export const datasetDetailResource = resource('cdc://datasets/{datasetId}', {
  name: 'CDC Dataset Detail',
  description: `Dataset metadata and column schema for a specific CDC dataset, addressable by URI. Carries the first ${COLUMN_WINDOW} columns, the dataset's total column count, and a truncation flag; call cdc_get_dataset_schema with column_offset for the columns beyond that window.`,
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

    /**
     * The metadata endpoint answers 200 for every catalog asset, so an empty `columns`
     * array is what separates a tabular dataset from a chart, map, story, file, or link.
     * Returning that bare is a failed lookup dressed as a result.
     */
    if (metadata.columns.length === 0) {
      throw ctx.fail(
        'not_queryable',
        `Dataset ${params.datasetId} ("${metadata.name}") has no columns. The ID names a non-tabular catalog asset, so there is no schema to return and cdc_query_dataset cannot read it.`,
        { ...ctx.recoveryFor('not_queryable') },
      );
    }

    const columnCount = metadata.columns.length;
    const columns = metadata.columns.slice(0, COLUMN_WINDOW);
    const truncated = columns.length < columnCount;

    ctx.log.info('Dataset detail resource accessed', {
      datasetId: params.datasetId,
      name: metadata.name,
      columnCount,
      columnsShown: columns.length,
    });

    return {
      ...metadata,
      columns,
      columnCount,
      truncated,
      ...(truncated
        ? {
            notice: `Showing the first ${columns.length} of ${columnCount} columns. Call cdc_get_dataset_schema with datasetId="${params.datasetId}" and column_offset=${columns.length} for the rest; every column is reachable that way.`,
          }
        : {}),
    };
  },
});
