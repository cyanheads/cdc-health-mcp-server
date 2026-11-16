/**
 * @fileoverview The tool definitions the server registers, in `tools/list` order, with the two
 * dataframe tools gated on the deployment's DataCanvas.
 * @module mcp-server/tools/server-tools
 */

import { disabledTool } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { dataframeDescribe } from '@/mcp-server/tools/definitions/dataframe-describe.tool.js';
import { dataframeQuery } from '@/mcp-server/tools/definitions/dataframe-query.tool.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { listCatalogVocabulary } from '@/mcp-server/tools/definitions/list-catalog-vocabulary.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';

/**
 * Every tool `createApp()` registers for a deployment whose canvas provider is `providerType`.
 * The dataframe tools read only what cdc_query_wonder stages, which needs a DataCanvas, so under
 * `'none'` they are `disabledTool()`s: on the landing page, muted, and out of `tools/list`.
 */
export function serverTools(providerType: AppConfig['canvas']['providerType']) {
  const dataframeTools = [dataframeDescribe, dataframeQuery].map((definition) =>
    providerType === 'none'
      ? disabledTool(definition, {
          reason:
            'This deployment runs without a DataCanvas, so cdc_query_wonder stages no tables to query.',
        })
      : definition,
  );
  return [
    discoverDatasets,
    getDatasetSchema,
    listCatalogVocabulary,
    queryDataset,
    queryWonder,
    ...dataframeTools,
  ];
}
