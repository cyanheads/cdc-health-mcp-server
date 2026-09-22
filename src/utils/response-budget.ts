/**
 * @fileoverview The response budget shared by the row-returning tools, and the measure it is
 * counted in.
 * @module utils/response-budget
 */

/**
 * Ceiling on one tool result, in characters of the serialized result — `structuredContent`
 * and `content[]` together, as a caller receives them. `cdc_query_dataset` and
 * `cdc_query_wonder` both bound their pages by it and name it in their descriptions, so the
 * figure lives in one place. Each tool charges its own rows, since a sparse Socrata row and a
 * fixed-width WONDER row with cell notes cost different things.
 */
export const MAX_RESPONSE_CHARS = 200_000;

/** Length of `text` once embedded in a JSON string — the form it takes on the wire. */
export function jsonLength(text: string): number {
  return JSON.stringify(text).length - 2;
}
