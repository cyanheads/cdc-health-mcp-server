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
  instructions: `Use the cdc_* tools to access the CDC Open Data portal (~1,487 datasets) via the Socrata SODA API: search the catalog, inspect dataset schemas, and run SoQL queries across mortality, vaccinations, behavioral risk, surveillance, and other public health domains. Datasets are addressed by four-by-four IDs (e.g. bi63-dtpu); the catalog is heterogeneous, so the workflow is discover → inspect schema → query. All values come back as strings, and a column like "year" may be numeric in one dataset and text in another — match WHERE literals to the actual dataType from the schema.`,
  tools: [discoverDatasets, getDatasetSchema, queryDataset],
  resources: [datasetsResource, datasetDetailResource],
  prompts: [analyzeHealthTrend],
  landing: { requireAuth: false },
  setup() {
    initSocrataService();
  },
});
