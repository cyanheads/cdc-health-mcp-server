#!/usr/bin/env node
/**
 * @fileoverview cdc-health-statistics-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';

await createApp({
  tools: [],
  resources: [],
  prompts: [],
});
