/**
 * @fileoverview Serves tool definitions through the framework's worker handler and returns the
 * `tools/list` response body a client receives.
 * @module tests/helpers/tools-list
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { vi } from 'vitest';

const PROTOCOL_VERSION = '2026-07-28';

type ToolDefinitions = NonNullable<NonNullable<Parameters<typeof createWorkerHandler>[0]>['tools']>;

/**
 * Sends one `tools/list` to a worker handler serving `tools` and returns the JSON-RPC response
 * body, with an event-stream reply reduced to its data lines.
 */
export async function listToolsBody(tools: ToolDefinitions): Promise<string> {
  // Worker initialization writes all three; restored by the caller's `vi.unstubAllEnvs()`.
  vi.stubEnv('IS_SERVERLESS', undefined);
  vi.stubEnv('MCP_TRANSPORT_TYPE', undefined);
  vi.stubEnv('MCP_LOG_LEVEL', undefined);
  const worker = createWorkerHandler({ name: 'cdc-health-mcp-server', tools });
  const response = await worker.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'tools-list-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    { LOG_LEVEL: 'error' },
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const text = await response.text();
  return text.startsWith('event:') || text.startsWith('data:') ? sseData(text) : text;
}

function sseData(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
}
