/**
 * @fileoverview Parses a CDC WONDER `<data-table>` XML response into keyed row objects.
 * The table is HTML-table-like: the leading (outer) dimension cell of each group carries a
 * rowspan (`r="N"`) and is omitted on the group's subsequent rows, so dimension values must
 * be carried forward. Measure values arrive with comma thousands separators, or as a status
 * token ("Suppressed", "Unreliable", "Not Applicable") in place of a number. Pure module (no
 * framework imports).
 * @module services/wonder/xml-parser
 */

import { isSuppressedToken, type WonderCellNote, type WonderRow } from './types.js';

/** Read an XML attribute value from a cell's attribute string (anchored to an attr-name start). */
function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/** Minimal HTML entity decode for caveat/footnote text. */
function decodeEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&nbsp;', ' ');
}

/** Strip CDATA wrapper + HTML tags from caveat/footnote inner content, collapse whitespace. */
function cleanText(inner: string): string {
  return decodeEntities(
    inner
      .replace(/^\s*<!\[CDATA\[/, '')
      .replace(/\]\]>\s*$/, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A caveat WONDER emitted as an unresolved template expression — `wonder:<name>()` or
 * `wonder:<name>('arg')` — rather than expanding it to footnote prose. Matched against the
 * whole caveat, never as a substring, so legitimate prose mentioning WONDER survives.
 */
const UNRESOLVED_TEMPLATE = /^wonder:[\w-]+\(.*\)$/i;

/**
 * Parse a single measure cell. A numeric value (comma thousands separators stripped) becomes
 * a number with no token; an empty cell becomes null with no token. Anything else is a WONDER
 * status token — the value is null and the token comes back verbatim, so callers can tell a
 * "Suppressed"/"Unreliable"/"Not Applicable" null apart from an absent one.
 */
function parseMeasure(raw: string | undefined): { value: number | null; token: string | null } {
  const t = (raw ?? '').trim();
  if (t === '') return { value: null, token: null };
  const n = Number(t.replaceAll(',', ''));
  if (Number.isFinite(n)) return { value: n, token: null };
  return { value: null, token: t };
}

/** Extracted rows, caveats/footnotes, and the status tokens found in measure cells. */
export interface ParsedTable {
  caveats: string[];
  cellNotes: WonderCellNote[];
  rows: WonderRow[];
  suppressedCount: number;
}

/**
 * Parse a WONDER response body into rows keyed by `columns`.
 *
 * @param body - Full XML response text.
 * @param columns - Ordered output keys: `dimensionCount` dimensions followed by measures.
 * @param dimensionCount - Number of leading dimension columns (for rowspan reconstruction).
 * @returns Parsed rows, resolved caveats/footnotes, and the status tokens found in measure cells.
 */
export function parseDataTable(
  body: string,
  columns: string[],
  dimensionCount: number,
): ParsedTable {
  const measureCount = columns.length - dimensionCount;

  const caveats = [
    ...[...body.matchAll(/<caveat>([\s\S]*?)<\/caveat>/g)].map((m) => cleanText(m[1] ?? '')),
    ...[...body.matchAll(/<footnote\b[^>]*>([\s\S]*?)<\/footnote>/g)].map((m) =>
      cleanText(m[1] ?? ''),
    ),
  ].filter((c) => c.length > 0 && !UNRESOLVED_TEMPLATE.test(c));

  const tableMatch = body.match(/<data-table\b[^>]*>([\s\S]*?)<\/data-table>/);
  const tableInner = tableMatch?.[1];
  if (!tableInner) return { rows: [], caveats, cellNotes: [], suppressedCount: 0 };

  const rows: WonderRow[] = [];
  const cellNotes: WonderCellNote[] = [];
  const carried: string[] = new Array<string>(dimensionCount).fill('');

  for (const rowMatch of tableInner.matchAll(/<r>([\s\S]*?)<\/r>/g)) {
    const cells = [...(rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)\/?>/g)].map((m) => m[1] ?? '');
    // Skip subtotal/total rows (defensive — absent when O_show_totals=false):
    // they carry a `dt` cell or a leading `c=` colspan marker.
    const first = cells[0];
    const isTotalsRow =
      cells.some((c) => attr(c, 'dt') !== undefined) ||
      (first !== undefined && attr(first, 'c') !== undefined && attr(first, 'l') === undefined);
    if (isTotalsRow) continue;
    if (cells.length < measureCount) continue;

    // Leading cells are the dimension labels present on this row; trailing `measureCount` are measures.
    const dimCells = cells.slice(0, cells.length - measureCount);
    const measureCells = cells.slice(cells.length - measureCount);
    if (dimCells.length > dimensionCount) continue; // anomalous — never emitted by WONDER for D76

    // Rowspan carry: present dimension cells fill the trailing dimension slots; the
    // leading slots (omitted due to rowspan) keep the previous row's value.
    const present = dimCells.length;
    for (let j = 0; j < present; j++) {
      carried[dimensionCount - present + j] = decodeEntities(attr(dimCells[j] ?? '', 'l') ?? '');
    }

    const row: WonderRow = {};
    for (let i = 0; i < dimensionCount; i++) {
      const key = columns[i];
      if (key !== undefined) row[key] = carried[i] ?? '';
    }
    for (let m = 0; m < measureCount; m++) {
      const key = columns[dimensionCount + m];
      if (key === undefined) continue;
      const { value, token } = parseMeasure(attr(measureCells[m] ?? '', 'v'));
      row[key] = value;
      if (token !== null) cellNotes.push({ row: rows.length, column: key, token });
    }
    rows.push(row);
  }

  return {
    rows,
    caveats,
    cellNotes,
    suppressedCount: cellNotes.filter((n) => isSuppressedToken(n.token)).length,
  };
}
