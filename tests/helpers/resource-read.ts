/**
 * @fileoverview Reads a resource through the framework's resource handler factory and returns
 * the JSON-RPC error a client would receive.
 * @module tests/helpers/resource-read
 */

import type { resource } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { vi } from 'vitest';

const PROTOCOL_VERSION = '2026-07-28';

/** The JSON-RPC `error` member of a failed `resources/read`. */
export interface ResourceReadError {
  code: number;
  data: {
    reason?: string;
    recovery?: { hint: string };
    retryable?: boolean;
    [key: string]: unknown;
  };
  message: string;
}

/**
 * Serves `definition` from a worker handler and sends it one `resources/read` for `uri`.
 * A direct `definition.handler(...)` call returns the throw site's error untouched; this path
 * applies the factory's fill of the declared recovery hint, as production does.
 */
export async function readResourceError(
  definition: ReturnType<typeof resource>,
  uri: string,
): Promise<ResourceReadError> {
  // Worker initialization writes all three; restored by the caller's `vi.unstubAllEnvs()`.
  vi.stubEnv('IS_SERVERLESS', undefined);
  vi.stubEnv('MCP_TRANSPORT_TYPE', undefined);
  vi.stubEnv('MCP_LOG_LEVEL', undefined);
  const worker = createWorkerHandler({ name: 'cdc-health-mcp-server', resources: [definition] });
  const response = await worker.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'resources/read',
        'Mcp-Name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'resource-read-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    { LOG_LEVEL: 'error' },
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const text = await response.text();
  const body = text.startsWith('event:') || text.startsWith('data:') ? sseData(text) : text;
  const message = JSON.parse(body) as { error?: ResourceReadError };
  if (!message.error) throw new Error(`resources/read did not fail: ${text}`);
  return message.error;
}

function sseData(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
}
