#!/usr/bin/env node
/**
 * @fileoverview cdc-health-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { analyzeHealthTrend } from '@/mcp-server/prompts/definitions/analyze-health-trend.prompt.js';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';

await createApp({
  name: 'cdc-health-mcp-server',
  title: 'cdc-health-mcp-server',
  instructions: `Use the cdc_* tools to access CDC public health data. Most tools query the CDC Open Data portal (~1,080 datasets) via the Socrata SODA API: search the catalog, inspect dataset schemas, and run SoQL queries across vaccinations, behavioral risk, surveillance, and other domains. Datasets are addressed by four-by-four IDs (e.g. bi63-dtpu); the catalog is heterogeneous, so the workflow is discover → inspect schema → query. All Socrata values come back as strings, and a column like "year" may be numeric in one dataset and text in another — match WHERE literals to the actual dataType from the schema. Separately, cdc_query_wonder queries CDC WONDER — a different CDC system — for national mortality statistics (deaths, population, crude/age-adjusted rates), grouped by year/age/sex/race and filtered by ICD-10 cause; its database input selects one of five mortality databases (final and provisional, underlying-cause and multiple-cause) covering 1999 through the current year. It is national-only, and CDC rejects requests made less than 15 seconds apart, so consecutive calls are spaced automatically.`,
  tools: [discoverDatasets, getDatasetSchema, queryDataset, queryWonder],
  resources: [datasetsResource, datasetDetailResource],
  prompts: [analyzeHealthTrend],
  landing: { requireAuth: false },
  setup() {
    initSocrataService();
    initWonderService();
  },
});
