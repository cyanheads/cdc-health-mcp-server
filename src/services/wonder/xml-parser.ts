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
 * assembled string would do the same. Elements are found by forward scans that pair tags as
 * lazy regexes would, in time linear in the body (see `elementContents`). Pure module (no
 * framework imports).
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

/** Where an anchor opens: `<a` as a whole tag name, in any case. Matched on raw markup only. */
const ANCHOR_OPEN = /<a\b/gi;
/** Where an anchor closes. */
const ANCHOR_CLOSE = /<\/a\s*>/gi;

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
 *
 * An anchor runs from `<a` through the first `>` (its attributes) and on to the first `</a>`
 * after that. The scan reads the markup once: when an opener finds no `>` or no closer after
 * it, no later opener can find one either, so everything from there on is text and is left to
 * `stripAndDecode`. Linear in the length of the markup.
 */
function toLinkedText(markup: string): string {
  let out = '';
  let last = 0;
  ANCHOR_OPEN.lastIndex = 0;
  for (let open = ANCHOR_OPEN.exec(markup); open; open = ANCHOR_OPEN.exec(markup)) {
    const tagEnd = markup.indexOf('>', ANCHOR_OPEN.lastIndex);
    if (tagEnd === -1) break;
    ANCHOR_CLOSE.lastIndex = tagEnd + 1;
    const close = ANCHOR_CLOSE.exec(markup);
    if (!close) break;
    out += stripAndDecode(markup.slice(last, open.index));
    out += renderAnchor(
      markup.slice(ANCHOR_OPEN.lastIndex, tagEnd),
      markup.slice(tagEnd + 1, close.index),
    );
    last = ANCHOR_CLOSE.lastIndex;
    ANCHOR_OPEN.lastIndex = last;
  }
  return collapseWhitespace(out + stripAndDecode(markup.slice(last)));
}

/** Strip the CDATA wrapper from caveat/footnote/message content, then render it as linked text. */
function cleanText(inner: string): string {
  return toLinkedText(inner.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, ''));
}

/**
 * What may follow an element's name inside its opening tag. `exact` is `<name>` alone (a
 * `<caveat code="…">` definition is not a `<caveat>`); `word` is `<name\b[^>]*>`, where the
 * name must end (`<footnotes>` is not a `<footnote>`); `prefix` is `<name[^>]*>`, which also
 * opens on a longer name that starts with it.
 */
type OpenerShape = 'exact' | 'prefix' | 'word';

/** A character that continues a name past a regex `\b` — `\w`, ASCII letters, digits and `_`. */
const NAME_CHAR = /\w/;

/**
 * The next opening tag of `name` at or after `from`, as the offsets where its attributes start
 * and where its `>` sits — or undefined once no opener with a `>` after it remains. A tag runs
 * to its first `>`; when an opener finds none, no later opener can either.
 */
function nextOpeningTag(
  markup: string,
  name: string,
  shape: OpenerShape,
  from: number,
): { attrsStart: number; tagEnd: number } | undefined {
  const open = `<${name}`;
  for (let at = markup.indexOf(open, from); at !== -1; at = markup.indexOf(open, at + 1)) {
    const attrsStart = at + open.length;
    const next = markup.charAt(attrsStart);
    if (shape === 'exact' ? next !== '>' : shape === 'word' && NAME_CHAR.test(next)) continue;
    const tagEnd = markup.indexOf('>', attrsStart);
    return tagEnd === -1 ? undefined : { attrsStart, tagEnd };
  }
  return;
}

/**
 * The content of every `<name…>…</name>` element in `markup`, in document order, read in one
 * forward pass. Pairs as the lazy `<name…>([\s\S]*?)</name>` regex does: the content runs from
 * the opening tag's `>` to the first `</name>` after it, and the scan resumes past that closer.
 * When an opener finds no closer, no later opener can, so the scan stops there. Linear in the
 * length of the markup.
 */
function elementContents(markup: string, name: string, shape: OpenerShape): string[] {
  const close = `</${name}>`;
  const contents: string[] = [];
  let tag = nextOpeningTag(markup, name, shape, 0);
  while (tag) {
    const end = markup.indexOf(close, tag.tagEnd + 1);
    if (end === -1) break;
    contents.push(markup.slice(tag.tagEnd + 1, end));
    tag = nextOpeningTag(markup, name, shape, end + close.length);
  }
  return contents;
}

/**
 * The attribute string of every `<c …>` cell in a row, in order, read in one forward pass.
 * Pairs as `<c\b([^>]*?)\/?>` does: the tag runs to its first `>`, and the `/` of a
 * self-closing cell is not part of its attributes.
 */
function cellAttributes(row: string): string[] {
  const cells: string[] = [];
  let tag = nextOpeningTag(row, 'c', 'word', 0);
  while (tag) {
    const attrs = row.slice(tag.attrsStart, tag.tagEnd);
    cells.push(attrs.endsWith('/') ? attrs.slice(0, -1) : attrs);
    tag = nextOpeningTag(row, 'c', 'word', tag.tagEnd + 1);
  }
  return cells;
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
  return elementContents(body, 'message', 'prefix')
    .map(cleanText)
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
    ...elementContents(body, 'caveat', 'exact'),
    ...elementContents(body, 'footnote', 'word'),
  ]
    .map(cleanText)
    .filter((c) => c.length > 0 && !UNRESOLVED_TEMPLATE.test(c));

  const tableInner = elementContents(body, 'data-table', 'word')[0];
  if (!tableInner) return { rows: [], caveats, cellNotes: [], suppressedCount: 0 };

  const rows: WonderRow[] = [];
  const cellNotes: WonderCellNote[] = [];
  const carried: string[] = new Array<string>(dimensionCount).fill('');

  for (const rowInner of elementContents(tableInner, 'r', 'exact')) {
    const cells = cellAttributes(rowInner);
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
