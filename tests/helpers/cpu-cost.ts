/**
 * @fileoverview CPU-cost assertions shared by the tests that pin linear-time scans: a worst-case
 * input 64× longer may cost under 256× the CPU, or each doubling under four times the growth.
 * @module tests/helpers/cpu-cost
 */

import { expect } from 'vitest';

const SMALL = 5_000;
const LARGE = 320_000;

/** Calls timed together on the small input, so its per-call cost sits well above the timer's microsecond. */
const SMALL_BATCH = 32;

/** Measurements taken of each input; its cost is the least of them. */
const SAMPLES = 3;

/** CPU time on this thread since `start`, in microseconds — immune to scheduler noise. */
function cpuSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.threadCpuUsage(start);
  return user + system;
}

/**
 * The least CPU, in microseconds, that `calls` back-to-back calls of `run` took across
 * {@link SAMPLES} measurements. A garbage-collection pause or a cold cache only ever adds time,
 * so the least measurement is the cost of the work itself.
 */
function leastCost(run: () => unknown, calls: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = process.threadCpuUsage();
    for (let i = 0; i < calls; i++) run();
    least = Math.min(least, cpuSince(start));
  }
  return least;
}

/**
 * The least CPU, in microseconds, of one call of `run` across {@link SAMPLES} measurements, for
 * code under test that returns a promise. Each call runs a whole service path, so one call
 * already costs well above the timer's microsecond, and a batch would only add the service's
 * real-time request spacing to the test's run.
 */
async function leastCostAsync(run: () => Promise<unknown>): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = process.threadCpuUsage();
    await run();
    least = Math.min(least, cpuSince(start));
  }
  return least;
}

/** The growth bound: under 256× the CPU per call for 64× the input, and the long run under a second. */
function expectLinear(smallCost: number, largeCost: number) {
  expect(largeCost / Math.max(smallCost, 1)).toBeLessThan(256);
  expect(largeCost).toBeLessThan(1_000_000);
}

/**
 * Asserts `run` grows linearly: markup 64× longer may cost under 256× as much CPU per call, and
 * the long run stays under a second. Each input keeps its least of several measurements, and the
 * small one is timed per call over a batch, so neither the timer's resolution nor one pause
 * decides the ratio.
 *
 * @param build - Builds the worst-case input of roughly `n` characters.
 * @param run - The code under test, called with that input.
 */
export function expectLinearCost(build: (n: number) => string, run: (input: string) => unknown) {
  const small = build(SMALL);
  const large = build(LARGE);
  run(small); // warm the JIT before measuring
  const smallCost = leastCost(() => run(small), SMALL_BATCH) / SMALL_BATCH;
  expectLinear(
    smallCost,
    leastCost(() => run(large), 1),
  );
}

/** `unit` repeated to at least `n` characters. */
export function fill(unit: string, n: number): string {
  return unit.repeat(Math.ceil(n / unit.length));
}

/**
 * Asserts `scan` stays linear while the input doubles from 5,000 characters to `largest`: at every
 * size the least CPU of several measurements of `repeats` scans stays under four times the
 * growth, so a quadratic scan breaks the bound by the second doubling, before an expensive size
 * runs.
 *
 * @param build - Builds the worst-case input of roughly `n` characters.
 * @param largest - The last size to check.
 * @param scan - The code under test, called with that input.
 * @param repeats - Scans per size, enough that the 5,000-character base costs well above timer jitter.
 */
export function expectLinearDoublings(
  build: (n: number) => string,
  largest: number,
  scan: (input: string) => unknown,
  repeats: number,
) {
  const cost = (input: string): number => leastCost(() => scan(input), repeats);
  cost(build(SMALL)); // warm the JIT before measuring
  const base = Math.max(cost(build(SMALL)), 1);
  for (let n = SMALL * 2; n <= largest; n *= 2) {
    const growth = n / SMALL;
    const at = cost(build(n));
    expect(at / base, `${n} characters`).toBeLessThan(4 * growth);
    expect(at, `${n} characters`).toBeLessThan(1_000_000);
  }
}

/**
 * {@link expectLinearCost} for code under test that returns a promise: each input keeps its least
 * of several one-call measurements.
 */
export async function expectLinearCostAsync(
  build: (n: number) => string,
  run: (input: string) => Promise<unknown>,
) {
  const small = build(SMALL);
  const large = build(LARGE);
  await run(small); // warm the JIT before measuring
  expectLinear(await leastCostAsync(() => run(small)), await leastCostAsync(() => run(large)));
}
