/**
 * @fileoverview serverTools, the tool list src/index.ts hands createApp(): what tools/list
 * carries with a DuckDB canvas and without one, served through the framework's worker handler.
 * @module tests/mcp-server/tools/server-tools
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverTools } from '@/mcp-server/tools/server-tools.js';
import { listToolsBody } from '../../helpers/tools-list.js';

const SOCRATA_AND_WONDER = [
  'cdc_discover_datasets',
  'cdc_get_dataset_schema',
  'cdc_list_catalog_vocabulary',
  'cdc_query_dataset',
  'cdc_query_wonder',
];
const DATAFRAME = ['cdc_dataframe_describe', 'cdc_dataframe_query'];

/** The tool names tools/list carries for a deployment whose canvas provider is `providerType`. */
async function listed(providerType: 'duckdb' | 'none'): Promise<string[]> {
  const body = await listToolsBody(serverTools(providerType));
  return (JSON.parse(body) as { result: { tools: { name: string }[] } }).result.tools.map(
    (tool) => tool.name,
  );
}

describe('serverTools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists both dataframe tools after the rest on a DuckDB canvas', async () => {
    expect(await listed('duckdb')).toEqual([...SOCRATA_AND_WONDER, ...DATAFRAME]);
  });

  it('lists neither dataframe tool without a canvas, still handing both to createApp()', async () => {
    expect(await listed('none')).toEqual(SOCRATA_AND_WONDER);
    // Disabled rather than dropped, so the landing page still names them.
    expect(serverTools('none').map((tool) => tool.name)).toEqual([
      ...SOCRATA_AND_WONDER,
      ...DATAFRAME,
    ]);
  });
});
