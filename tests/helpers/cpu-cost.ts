/**
 * @fileoverview CPU-cost assertions shared by the tests that pin linear-time scans: a worst-case
 * input 64× longer may cost under 256× the CPU.
 * @module tests/helpers/cpu-cost
 */

import { expect } from 'vitest';

const SMALL = 5_000;
const LARGE = 320_000;

/** CPU time on this thread since `start`, in microseconds — immune to scheduler noise. */
function cpuSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.threadCpuUsage(start);
  return user + system;
}

/** The growth bound: under 256× the CPU for 64× the input, and the long run under a second. */
function expectLinear(smallCost: number, largeCost: number) {
  expect(largeCost / Math.max(smallCost, 1)).toBeLessThan(256);
  expect(largeCost).toBeLessThan(1_000_000);
}

/**
 * Asserts `run` grows linearly: markup 64× longer may cost under 256× as much CPU, and the long
 * run stays under a second.
 *
 * @param build - Builds the worst-case input of roughly `n` characters.
 * @param run - The code under test, called with that input.
 */
export function expectLinearCost(build: (n: number) => string, run: (input: string) => unknown) {
  const small = build(SMALL);
  const large = build(LARGE);
  run(small); // warm the JIT before measuring
  let start = process.threadCpuUsage();
  run(small);
  const smallCost = cpuSince(start);
  start = process.threadCpuUsage();
  run(large);
  expectLinear(smallCost, cpuSince(start));
}

/** {@link expectLinearCost} for code under test that returns a promise. */
export async function expectLinearCostAsync(
  build: (n: number) => string,
  run: (input: string) => Promise<unknown>,
) {
  const small = build(SMALL);
  const large = build(LARGE);
  await run(small); // warm the JIT before measuring
  let start = process.threadCpuUsage();
  await run(small);
  const smallCost = cpuSince(start);
  start = process.threadCpuUsage();
  await run(large);
  expectLinear(smallCost, cpuSince(start));
}
