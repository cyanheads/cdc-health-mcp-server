/**
 * @fileoverview A real DuckDB DataCanvas for the staging tests, handed to the tools through
 * `setCanvas`. Every `runToolContract` call builds a context with its own empty `ctx.state`,
 * where a deployed server's calls all read one tenant store; `shareTenantStore` restores that,
 * so a table one call stages is the table the next call finds. `stageWonderTable` stages one
 * through cdc_query_wonder itself.
 * @module tests/helpers/staging-canvas
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createCanvasService, type DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { parseConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import type { WonderGroupBy } from '@/services/wonder/types.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';

/** A DuckDB canvas built from `overrides` on top of `CANVAS_PROVIDER_TYPE=duckdb`, set as the server's canvas. */
export function createStagingCanvas(overrides: Record<string, string> = {}): DataCanvas {
  const canvas = createCanvasService(parseConfig({ CANVAS_PROVIDER_TYPE: 'duckdb', ...overrides }));
  if (!canvas)
    throw new Error('createCanvasService returned no canvas for CANVAS_PROVIDER_TYPE=duckdb.');
  setCanvas(canvas);
  return canvas;
}

/**
 * Route every `acquireShared` call on `canvas` through one fresh store for `tenantId`, keeping
 * each call's own signal. Returns a context on that store for reading what was staged.
 */
export function shareTenantStore(canvas: DataCanvas, tenantId = 'default'): Context {
  const store = createMockContext({ tenantId });
  const acquireShared = canvas.acquireShared.bind(canvas);
  vi.spyOn(canvas, 'acquireShared').mockImplementation((ctx, options) =>
    acquireShared({ ...ctx, state: store.state }, options),
  );
  return store;
}

/** Shut `canvas` down and clear it from the server. */
export async function disposeStagingCanvas(canvas: DataCanvas): Promise<void> {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext());
}

/** A year-grouped WONDER response of `n` rows whose death count is the row's own index. */
export function numberedWonderTable(n: number): string {
  const rows = Array.from(
    { length: n },
    (_, i) =>
      `<r><c l="${1999 + (i % 22)}"/><c v="${i}"/><c v="1,000"/><c v="1.0"/><c v="1.0"/></r>`,
  );
  return `<page><data-table>${rows.join('')}</data-table></page>`;
}

/**
 * Stage the table WONDER answers with `body` by calling cdc_query_wonder at offset 0 with its
 * default page, against a fresh service so no earlier call's gap holds it back. `body` must
 * hold more rows than that page. Returns the staged table's name.
 */
export async function stageWonderTable(
  body: string,
  groupBy: readonly WonderGroupBy[],
): Promise<string> {
  initWonderService();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
  const result = await runToolContract(queryWonder, { group_by: [...groupBy] });
  const name = (result.structuredContent as { stagedTable?: string }).stagedTable;
  if (!name) throw new Error('cdc_query_wonder staged no table; the body fits one page.');
  return name;
}
