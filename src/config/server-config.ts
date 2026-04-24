/**
 * @fileoverview CDC server-specific configuration. Lazy-parsed from environment variables.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  appToken: z.string().optional().describe('Socrata app token for higher rate limits'),
  baseUrl: z
    .string()
    .url()
    .default('https://data.cdc.gov')
    .describe('Base URL for SODA API requests'),
  catalogUrl: z
    .string()
    .url()
    .default('https://api.us.socrata.com/api/catalog/v1')
    .describe('Base URL for Socrata Discovery API'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    appToken: 'CDC_APP_TOKEN',
    baseUrl: 'CDC_BASE_URL',
    catalogUrl: 'CDC_CATALOG_URL',
  });
  return _config;
}
