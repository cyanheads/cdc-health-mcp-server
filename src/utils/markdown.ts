/**
 * @fileoverview Markdown rendering helpers shared by tool `format()` functions.
 * @module utils/markdown
 */

/**
 * Make an upstream string safe to interpolate into a single markdown table cell.
 *
 * A raw `|` splits the row into extra columns and a raw newline terminates it, so a single
 * unescaped value corrupts the whole rendered table for `content[]`-only clients. Every
 * value that reaches a table cell comes from CDC payloads (Socrata column metadata, SODA
 * row values, WONDER measure cells), none of which are constrained to stay single-line.
 *
 * @param value - Raw text destined for a table cell.
 * @returns The text with pipes escaped and all line breaks collapsed to single spaces.
 */
export function escapeTableCell(value: string): string {
  return value
    .replaceAll('|', '\\|')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}
