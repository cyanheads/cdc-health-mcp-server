/**
 * @fileoverview The four-by-four dataset ID input shared by every definition that takes one.
 * @module mcp-server/schemas/dataset-id
 */

import { caseNormalizedString } from '@/mcp-server/schemas/case-normalized-string.js';

/**
 * A four-by-four dataset ID, e.g. `bi63-dtpu`. Every ID the CDC catalog publishes is lowercase,
 * and Socrata answers an uppercase one with a 404 on both hosts, so an uppercase letter is
 * lowercased before the pattern check. Each definition adds its own `.describe()`.
 *
 * @param definition - The tool name or resource URI template, which labels the rewrite counter.
 */
export function datasetIdSchema(definition: string) {
  return caseNormalizedString({
    definition,
    error: 'Expected a four-by-four ID such as "bi63-dtpu".',
    field: 'datasetId',
    letterCase: 'lower',
    pattern: /^[a-z0-9]{4}-[a-z0-9]{4}$/,
  });
}
