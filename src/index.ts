#!/usr/bin/env node
/**
 * @fileoverview cdc-health-statistics-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { analyzeHealthTrend } from '@/mcp-server/prompts/definitions/analyze-health-trend.prompt.js';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';

await createApp({
  tools: [discoverDatasets, getDatasetSchema, queryDataset],
  resources: [datasetsResource, datasetDetailResource],
  prompts: [analyzeHealthTrend],
  setup() {
    initSocrataService();
  },
});
