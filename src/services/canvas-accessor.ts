/**
 * @fileoverview The framework's DataCanvas, handed over in `setup(core)`. Handlers have no
 * `core`, so the canvas reaches them through this module; it is `undefined` wherever the
 * deployment runs without one.
 * @module services/canvas-accessor
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Called once from `setup(core)` with `core.canvas`. */
export const setCanvas = (canvas: DataCanvas | undefined): void => {
  _canvas = canvas;
};

/** The deployment's canvas, or `undefined` when it has none. */
export const getCanvas = (): DataCanvas | undefined => _canvas;

/**
 * The tenant's canvas for the dataframe tools, or `undefined` when nothing has been staged on
 * it. Never mints one: only staging does, through `acquireShared` on the same default key.
 *
 * @throws Error when the deployment has no canvas — the dataframe tools are registered only
 *   where it does.
 */
export function liveCanvas(ctx: Context): Promise<CanvasInstance | undefined> {
  if (!_canvas) throw new Error('No DataCanvas is configured, so no table can be staged.');
  return _canvas.acquireShared(ctx, { create: false });
}
