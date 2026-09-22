/**
 * @fileoverview Parses a CDC WONDER XML response — the `<data-table>` into keyed row objects,
 * and the `<message>` elements into plain text with Markdown links.
 * The table is HTML-table-like: the leading (outer) dimension cell of each group carries a
 * rowspan (`r="N"`) and is omitted on the group's subsequent rows, so dimension values must
 * be carried forward. Measure values arrive with comma thousands separators, or as a status
 * token ("Suppressed", "Unreliable", "Not Applicable") in place of a number. Dimension labels
 * are CDC's own text with only surrounding whitespace removed (see `dimensionLabel`). Caveat,
 * footnote, and message text is rendered as plain text with its links kept as Markdown links
 * (see `toLinkedText`): anchors are found on the raw markup before any tag comes off, and every
 * segment goes through the shared single-pass decode in `utils/text` exactly once — a
 * per-entity chain resolves `&amp;` first and turns `&amp;lt;` into `<`, and re-decoding the
 * assembled string would do the same. Pure module (no framework imports).
 * @module services/wonder/xml-parser
 */

import { collapseWhitespace, decodeEntities, stripAndDecode } from '@/utils/text.js';
import { isSuppressedToken, type WonderCellNote, type WonderRow } from './types.js';

/** Read an XML attribute value from a cell's attribute string (anchored to an attr-name start). */
function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/** Root-relative caveat links (`/wonder/help/…`) resolve against the WONDER host. */
const WONDER_ORIGIN = 'https://wonder.cdc.gov/';

/** One HTML anchor, attributes and inner markup captured. Matched on raw markup only. */
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * The absolute URL a caveat link points at, or undefined when it should not become a link.
 *
 * The href is decoded once (an attribute may carry `&amp;`), then resolved against the WONDER
 * host. A fragment on its own points into CDC's web page, which the caller never sees, and
 * `URL` passes `javascript:`, `data:` and `mailto:` straight through, so only an `http:` or
 * `https:` result is kept. `URL` percent-encodes the spaces CDC leaves in its fragments
 * (`#Assurance of Confidentiality`); parentheses it leaves alone, and a bare `)` would close
 * the Markdown link early, so those are encoded here.
 */
function linkTarget(attrs: string): string | undefined {
  const quoted = attrs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const href = decodeEntities(quoted?.[1] ?? quoted?.[2] ?? '').trim();
  if (href === '' || href.startsWith('#')) return;
  const url = URL.parse(href, WONDER_ORIGIN);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') return;
  return url.href.replaceAll('(', '%28').replaceAll(')', '%29');
}

/**
 * One anchor as Markdown: `[text](url)` when its href resolves to a web URL, its text alone
 * otherwise. `target`, `onclick` and every other attribute stay out of the output. Brackets
 * and backslashes in the text are escaped so the text cannot close the link early.
 */
function renderAnchor(attrs: string, inner: string): string {
  const text = collapseWhitespace(stripAndDecode(inner));
  const url = linkTarget(attrs);
  if (!url || text === '') return text;
  return `[${text.replace(/[\\[\]]/g, '\\$&')}](${url})`;
}

/**
 * Render caveat/message markup as plain text that keeps its links.
 *
 * Anchors are converted on the raw markup, before any tag is stripped — once the tag is gone
 * the href is gone with it. The text between anchors and each anchor's own text are decoded
 * separately, once each, and the assembled string is only whitespace-collapsed, never decoded
 * again: a second pass would turn the `&lt;` that `&amp;lt;` decodes to into `<`. For the same
 * reason an anchor CDC entity-escaped (`&lt;a href=…&gt;`) is never matched and stays literal
 * text. Text outside anchors renders exactly as `toPlainText` renders it.
 */
function toLinkedText(markup: string): string {
  let out = '';
  let last = 0;
  for (const match of markup.matchAll(ANCHOR)) {
    out += stripAndDecode(markup.slice(last, match.index));
    out += renderAnchor(match[1] ?? '', match[2] ?? '');
    last = match.index + match[0].length;
  }
  return collapseWhitespace(out + stripAndDecode(markup.slice(last)));
}

/** Strip the CDATA wrapper from caveat/footnote/message content, then render it as linked text. */
function cleanText(inner: string): string {
  return toLinkedText(inner.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, ''));
}

/**
 * Extract WONDER's `<message>` elements as plain text with links kept, in document order.
 *
 * WONDER uses the same element for two unrelated jobs. On a rejected request the first message
 * states why. On a successful one the messages are notices about the table that came back —
 * among them the "Rows with … are hidden." pair, which says the row set was filtered before it
 * was sent. Reading only the first would drop those, so every message comes back.
 */
export function parseMessages(body: string): string[] {
  return [...body.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)]
    .map((m) => cleanText(m[1] ?? ''))
    .filter((m) => m.length > 0);
}

/**
 * A dimension cell's label, as the row will carry it: CDC's own text with surrounding
 * whitespace removed and nothing inside it touched.
 *
 * The trim is not cosmetic. Two databases pad one label — D158 and D157 render their last
 * year as `2024 ` where every other year on every database, D176's own 2024 included, comes
 * back bare. Left in place, `"2024 " !== "2024"` splits one year into two keys the moment a
 * caller lines a row from one database up against the same year from another, and nothing in
 * the output marks the cell as different from the bare label beside it. Whitespace at the edge
 * of a label carries no meaning, so it is dropped here rather than left for every consumer to
 * discover. Composite labels stay verbatim — `2025 (provisional)` keeps its interior space.
 */
function dimensionLabel(raw: string | undefined): string {
  return decodeEntities(raw ?? '').trim();
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
    if (dimCells.length > dimensionCount) continue; // anomalous — no mortality database emits it

    // Rowspan carry: present dimension cells fill the trailing dimension slots; the
    // leading slots (omitted due to rowspan) keep the previous row's value.
    const present = dimCells.length;
    for (let j = 0; j < present; j++) {
      carried[dimensionCount - present + j] = dimensionLabel(attr(dimCells[j] ?? '', 'l'));
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
