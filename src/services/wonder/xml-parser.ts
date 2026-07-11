/**
 * @fileoverview Parses a CDC WONDER `<data-table>` XML response into keyed row objects.
 * The table is HTML-table-like: the leading (outer) dimension cell of each group carries a
 * rowspan (`r="N"`) and is omitted on the group's subsequent rows, so dimension values must
 * be carried forward. Measure values arrive with comma thousands separators and, when CDC
 * suppresses a cell (< 10 deaths), the literal "Suppressed". Pure module (no framework imports).
 * @module services/wonder/xml-parser
 */

import type { WonderRow } from './types.js';

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

/** Parse a single measure cell value: comma-stripped number, or null (empty / suppressed / non-numeric). */
function parseMeasure(raw: string | undefined): { value: number | null; suppressed: boolean } {
  const t = (raw ?? '').trim();
  if (t === '') return { value: null, suppressed: false };
  if (/^suppressed$/i.test(t)) return { value: null, suppressed: true };
  const n = Number(t.replaceAll(',', ''));
  if (Number.isFinite(n)) return { value: n, suppressed: false };
  return { value: null, suppressed: false };
}

/** Extracted caveats/footnotes plus a structural flag. */
export interface ParsedTable {
  caveats: string[];
  rows: WonderRow[];
  suppressedCount: number;
}

/**
 * Parse a WONDER response body into rows keyed by `columns`.
 *
 * @param body - Full XML response text.
 * @param columns - Ordered output keys: `dimensionCount` dimensions followed by measures.
 * @param dimensionCount - Number of leading dimension columns (for rowspan reconstruction).
 * @returns Parsed rows, caveats/footnotes, and suppressed-cell count.
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
  ].filter((c) => c.length > 0);

  const tableMatch = body.match(/<data-table\b[^>]*>([\s\S]*?)<\/data-table>/);
  const tableInner = tableMatch?.[1];
  if (!tableInner) return { rows: [], caveats, suppressedCount: 0 };

  const rows: WonderRow[] = [];
  const carried: string[] = new Array<string>(dimensionCount).fill('');
  let suppressedCount = 0;

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
      const { value, suppressed } = parseMeasure(attr(measureCells[m] ?? '', 'v'));
      if (suppressed) suppressedCount++;
      if (key !== undefined) row[key] = value;
    }
    rows.push(row);
  }

  return { rows, caveats, suppressedCount };
}
