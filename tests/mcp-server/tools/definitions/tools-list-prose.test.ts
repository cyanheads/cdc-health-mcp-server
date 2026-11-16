/**
 * @fileoverview Guards what every tool advertises in tools/list: a byte ceiling per tool on the
 * prose the server writes, and a snapshot of everything else, so a prose edit never moves
 * structure and new prose raises a ceiling on purpose.
 * @module tests/mcp-server/tools/definitions/tools-list-prose
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverTools } from '@/mcp-server/tools/server-tools.js';
import { listToolsBody } from '../../../helpers/tools-list.js';

/**
 * Every tool the server registers, from the list src/index.ts hands createApp(), with the DuckDB
 * canvas that lists the two dataframe tools — so a tool added to the server is measured here.
 */
const TOOLS = serverTools('duckdb');

/**
 * Most bytes of prose each tool may advertise. Prose is the JSON-serialized UTF-8 of the tool
 * description and of every schema `description` outside the framework's `error` envelope, quotes
 * and escapes included, plus each error contract's `when` as it renders in that envelope, escaped
 * and unquoted. A change that adds prose past a ceiling raises it here, in the same change.
 */
const PROSE_CEILING_BYTES: Record<string, number> = {
  cdc_discover_datasets: 6772,
  cdc_get_dataset_schema: 5831,
  cdc_list_catalog_vocabulary: 5113,
  cdc_query_dataset: 4384,
  cdc_query_wonder: 15899,
  cdc_dataframe_describe: 1841,
  cdc_dataframe_query: 3071,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface ListedTool {
  description: string;
  inputSchema: { [key: string]: Json };
  name: string;
  outputSchema: { [key: string]: Json; properties: { [key: string]: Json } };
  [key: string]: Json;
}

/** The tools/list result a client receives, served through the framework's worker handler. */
async function listTools(): Promise<ListedTool[]> {
  const body = await listToolsBody(TOOLS);
  return (JSON.parse(body) as { result: { tools: ListedTool[] } }).result.tools;
}

const bytes = (value: Json) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Every string `description` under `node`. */
function descriptions(node: Json, into: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) descriptions(child, into);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') into.push(value);
      else descriptions(value, into);
    }
  }
  return into;
}

/** `node` with every string `description` removed: what is left is structure. */
function withoutDescriptions(node: Json): Json {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

/** The definition behind a listed tool. */
function definitionOf(name: string) {
  const definition = TOOLS.find((tool) => tool.name === name);
  if (!definition) throw new Error(`tools/list names ${name}, which no definition declares`);
  return definition;
}

/** The framework's `error.data.reason` description, where each contract's `when` renders. */
function reasonDescription(tool: ListedTool): string {
  const error = tool.outputSchema.properties.error as {
    properties: { data: { properties: { reason: { description: string } } } };
  };
  return error.properties.data.properties.reason.description;
}

/** Bytes of prose `tool` advertises, as `PROSE_CEILING_BYTES` defines it. */
function proseBytes(tool: ListedTool): number {
  const { error: _envelope, ...properties } = tool.outputSchema.properties;
  const schemaProse = [
    ...descriptions(tool.inputSchema),
    ...descriptions({ ...tool.outputSchema, properties }),
  ].reduce((sum, text) => sum + bytes(text), 0);
  const whenProse = (definitionOf(tool.name).errors ?? []).reduce(
    (sum, { when }) => sum + bytes(when) - 2,
    0,
  );
  return bytes(tool.description) + schemaProse + whenProse;
}

describe('tools/list prose', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists every tool the ceilings cover, and no other', async () => {
    const names = (await listTools()).map((tool) => tool.name);
    expect(names.toSorted()).toEqual(Object.keys(PROSE_CEILING_BYTES).toSorted());
  });

  it('renders each error contract’s when verbatim, where the ceiling counts it', async () => {
    for (const tool of await listTools()) {
      const rendered = reasonDescription(tool);
      for (const { reason, when } of definitionOf(tool.name).errors ?? []) {
        expect(rendered, `${tool.name} ${reason}`).toContain(`\`${reason}\`: ${when}`);
      }
    }
  });

  it('keeps each tool’s prose within its ceiling', async () => {
    const measured = Object.fromEntries(
      (await listTools()).map((tool) => [tool.name, proseBytes(tool)]),
    );
    for (const [name, ceiling] of Object.entries(PROSE_CEILING_BYTES)) {
      expect(measured[name], name).toBeLessThanOrEqual(ceiling);
    }
  });

  it('advertises the same structure, prose aside', async () => {
    const stripped = (await listTools()).map(withoutDescriptions) as ListedTool[];
    /**
     * The year bounds run to the current year, so the snapshot names it rather than the number
     * a later year would contradict.
     */
    const wonder = stripped.find((tool) => tool.name === 'cdc_query_wonder');
    if (!wonder) throw new Error('tools/list carries no cdc_query_wonder');
    const range = (
      wonder.inputSchema.properties as {
        year_range: { properties: { from: { maximum: Json }; to: { maximum: Json } } };
      }
    ).year_range.properties;
    const year = new Date().getUTCFullYear();
    expect([range.from.maximum, range.to.maximum]).toEqual([year, year]);
    range.from.maximum = 'current UTC year';
    range.to.maximum = 'current UTC year';

    /** Codes and `retryable` never reach tools/list, so they are pinned off the definitions. */
    const contracts = TOOLS.map((tool) => ({
      tool: tool.name,
      errors: (tool.errors ?? []).map(
        (entry: { code: number; reason: string; retryable?: boolean }) => ({
          reason: entry.reason,
          code: entry.code,
          ...(entry.retryable === undefined ? {} : { retryable: entry.retryable }),
        }),
      ),
    }));

    await expect(
      `${JSON.stringify({ tools: stripped, contracts }, null, 2)}\n`,
    ).toMatchFileSnapshot('__snapshots__/tools-list-structure.json.snap');
  });
});
