/**
 * @fileoverview Failure text for a catalog asset that has no columns — a chart, map, story,
 * file, or link. The schema tool and the dataset resource both refuse such an ID and name where
 * its data lives instead: the parent dataset of a chart or map, the download URL of a file.
 * Pure module (no framework imports).
 * @module utils/non-queryable-asset
 */

import type { DatasetMetadata } from '@/services/socrata/types.js';

/** The `not_queryable` message and, when the asset points somewhere, its recovery hint. */
export interface NonQueryableFailure {
  message: string;
  options: { recovery: { hint: string } } | undefined;
}

/**
 * Describes why `metadata`, which has no columns, cannot be read as a dataset.
 * @param datasetId - The ID the caller asked for.
 * @param readParent - Builds the recovery hint for a chart or map, from the ID of the dataset it
 *   is built on. The hint names the caller's own surface (tool call or resource URI).
 */
export function nonQueryableFailure(
  datasetId: string,
  metadata: DatasetMetadata,
  readParent: (parentId: string) => string,
): NonQueryableFailure {
  const { file, parentId } = metadata;
  const noSchema = `Dataset ${datasetId} ("${metadata.name}") has no columns. The ID names a non-tabular catalog asset, so there is no schema to return and cdc_query_dataset cannot read it.`;
  if (file) {
    const name = file.name ? `, "${file.name}"` : '';
    const size =
      file.sizeBytes === undefined ? '' : ` (${file.sizeBytes.toLocaleString('en-US')} bytes)`;
    return {
      message: `${noSchema} It is a file${name}${size}, downloadable from ${file.downloadUrl}, which redirects to the file.`,
      options: {
        recovery: {
          hint: `Download the file with a GET request to ${file.downloadUrl} rather than querying this ID.`,
        },
      },
    };
  }
  if (!parentId) return { message: noSchema, options: undefined };
  return {
    message: `${noSchema} It is a view of dataset ${parentId}, which carries the rows behind it.`,
    options: { recovery: { hint: readParent(parentId) } },
  };
}
