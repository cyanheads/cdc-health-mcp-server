/**
 * @fileoverview The `content[]` text a tool call returns, as a caller reads it.
 * @module tests/helpers/contract-text
 */

/** Every text block of a `runToolContract` result, joined by newlines. */
export function contentText(result: { content: unknown }): string {
  return (result.content as { text?: string }[]).map((block) => block.text ?? '').join('\n');
}
