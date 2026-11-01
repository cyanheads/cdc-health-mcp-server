/**
 * @fileoverview Parses a CDC WONDER XML response — the `<data-table>` into keyed row objects,
 * the `<message>` elements into plain text with Markdown links, and the provisional database's
 * data-through date out of its `<dataset vintage>`.
 * The table is HTML-table-like: the leading (outer) dimension cell of each group carries a
 * rowspan (`r="N"`) and is omitted on the group's subsequent rows, so dimension values must
 * be carried forward. Measure values arrive with comma thousands separators, or as a status
 * token ("Suppressed", "Unreliable", "Not Applicable") in place of a number; a rate cell may
 * nest its 95% confidence interval as an `<l v="(lower - upper)"/>` child. Dimension labels
 * are CDC's own text with only surrounding whitespace removed (see `dimensionLabel`); a cause
 * grouping's cells may carry a code beside the label (`cd`, `h`), carried forward with it
 * through a rowspan (see `codeSources`). Caveat,
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
import {
  isSuppressedToken,
  WONDER_DIMENSION_CODES,
  WONDER_RATE_MEASURES,
  type WonderCellNote,
  type WonderDimensionCode,
  type WonderRow,
} from './types.js';

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

/** One `<c …>` cell of a row. */
interface Cell {
  /** The cell's attribute string, without the `/` of a self-closing cell. */
  attrs: string;
  /** The `v` of the `<l …>` child CDC nests in a rate cell to carry its confidence interval. */
  interval?: string | undefined;
}

/** The tag a rate cell's interval child opens with: `<l` as a whole tag name. */
const INTERVAL_OPEN = '<l';

/**
 * Every `<c …>` cell in a row, in order, read in one forward pass. A cell's tag pairs as
 * `<c\b([^>]*?)\/?>` does: it runs to its first `>`, and the `/` of a self-closing cell is not
 * part of its attributes.
 *
 * A cell that does not close itself may open with an interval child — `<c v="188.0" a="c"><l
 * v="(187.5 - 188.4)"/></c>`. The child counts only when it is the first tag inside the cell,
 * with nothing but whitespace before it; its tag runs to its first `>`, and the scan for the next
 * cell resumes past it. Every search starts where the last one ended, so the pass stays linear
 * in the row.
 */
function rowCells(row: string): Cell[] {
  const cells: Cell[] = [];
  let tag = nextOpeningTag(row, 'c', 'word', 0);
  while (tag) {
    const attrs = row.slice(tag.attrsStart, tag.tagEnd);
    let resume = tag.tagEnd + 1;
    if (attrs.endsWith('/')) {
      cells.push({ attrs: attrs.slice(0, -1) });
    } else {
      const child = row.indexOf('<', resume);
      const childEnd = child === -1 ? -1 : row.indexOf('>', child + INTERVAL_OPEN.length);
      const isInterval =
        childEnd !== -1 &&
        row.startsWith(INTERVAL_OPEN, child) &&
        !NAME_CHAR.test(row.charAt(child + INTERVAL_OPEN.length)) &&
        row.slice(resume, child).trim() === '';
      if (isInterval) {
        const childAttrs = row.slice(child + INTERVAL_OPEN.length, childEnd);
        cells.push({ attrs, interval: attr(childAttrs, 'v') });
        resume = childEnd + 1;
      } else {
        cells.push({ attrs });
      }
    }
    tag = nextOpeningTag(row, 'c', 'word', resume);
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

/** Month names as CDC spells them, in calendar order. */
const MONTHS: readonly string[] = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * A date as CDC writes one at the start of a vintage — `October 17, 2026`. Anchored, and each
 * part's characters are disjoint from the separator after it, so a failed match backtracks at
 * most once per character: linear in the vintage.
 */
const LEADING_DATE = /^([A-Za-z]+) +(\d{1,2}), *(\d{4})\b/;

/**
 * The last date of death a provisional response holds, as `YYYY-MM-DD`, or undefined when the
 * response names none.
 *
 * The provisional database states it in its `<dataset>` element's vintage —
 * `vintage="October 17, 2026 as of  October 25, 2026"`, the first date the one deaths run
 * through, the second the day the data was drawn — and restates it in a "Deaths occurring
 * through …" caveat. The final databases send a bare year there (`vintage="2024"`), which is no
 * date, so they read as undefined. So does a vintage that does not open with a real calendar
 * date: a guessed one would date a notice wrongly. Linear in the body.
 */
export function parseDataThrough(body: string): string | undefined {
  const tag = nextOpeningTag(body, 'dataset', 'word', 0);
  if (!tag) return;
  const vintage = decodeEntities(attr(body.slice(tag.attrsStart, tag.tagEnd), 'vintage') ?? '');
  const match = LEADING_DATE.exec(vintage.trim());
  if (!match) return;
  const month = MONTHS.indexOf((match[1] ?? '').toLowerCase());
  const day = Number(match[2]);
  const date = new Date(Date.UTC(Number(match[3]), month, day));
  if (month === -1 || date.getUTCMonth() !== month || date.getUTCDate() !== day) return;
  return date.toISOString().slice(0, 10);
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

/** One bound of an interval: a figure read the way a measure value is, or NaN for anything else. */
function boundValue(raw: string): number {
  const t = raw.trim();
  return t === '' ? Number.NaN : Number(t.replaceAll(',', ''));
}

/**
 * Parse a rate cell's interval, written by CDC as `(lower - upper)` with comma thousands
 * separators — `(1,035.1 - 1,037.5)`. Anything else — no parentheses, one figure or three, a
 * side that is not a number — yields no bounds rather than a guessed one. A rate is never
 * negative, so the one `-` is the separator. Linear in the value: one split and one pass per side.
 */
function parseInterval(raw: string | undefined): { lower: number; upper: number } | undefined {
  const t = (raw ?? '').trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return;
  const sides = t.slice(1, -1).split('-');
  if (sides.length !== 2) return;
  const lower = boundValue(sides[0] ?? '');
  const upper = boundValue(sides[1] ?? '');
  return Number.isFinite(lower) && Number.isFinite(upper) ? { lower, upper } : undefined;
}

/** Measure columns that carry interval bounds, as a lookup the row loop reads per cell. */
const RATE_MEASURES: ReadonlySet<string> = new Set(WONDER_RATE_MEASURES);

/** Extracted rows, caveats/footnotes, and the status tokens found in measure cells. */
export interface ParsedTable {
  caveats: string[];
  cellNotes: WonderCellNote[];
  rows: WonderRow[];
  suppressedCount: number;
}

/** Where one code key of a row is read from: a dimension slot, and the attribute of its cells. */
interface CodeSource {
  attribute: WonderDimensionCode['attribute'];
  slot: number;
}

/**
 * The code keys a table's rows carry, in row order, each with the dimension slot it is read
 * from: one per `WONDER_DIMENSION_CODES` entry whose grouping is among the dimensions, a later
 * entry replacing an earlier one that feeds the same key.
 */
function codeSources(
  columns: readonly string[],
  dimensionCount: number,
): Map<WonderDimensionCode['key'], CodeSource> {
  const sources = new Map<WonderDimensionCode['key'], CodeSource>();
  for (const { dimension, attribute, key } of WONDER_DIMENSION_CODES) {
    const slot = columns.indexOf(dimension);
    if (slot !== -1 && slot < dimensionCount) sources.set(key, { slot, attribute });
  }
  return sources;
}

/**
 * A dimension cell's code as the row carries it: a `cd` as CDC wrote it, surrounding
 * whitespace removed; an `h` as the integer it is. Null when the cell carries none, or an `h`
 * that is not an integer — a guessed level would misplace the row in the list.
 */
function dimensionCode(
  attrs: string,
  attribute: WonderDimensionCode['attribute'],
): string | number | null {
  const raw = decodeEntities(attr(attrs, attribute) ?? '').trim();
  if (raw === '') return null;
  if (attribute === 'cd') return raw;
  const level = Number(raw);
  return Number.isInteger(level) ? level : null;
}

/**
 * Parse a WONDER response body into rows keyed by `columns`. After the dimensions come the codes
 * the grouping's cells carry beside their labels — `cause_code`, then `cause_level`, each only
 * when a grouping that sends it is among the dimensions (see `WONDER_DIMENSION_CODES`) and null
 * on a row whose cell lacks it. Then the measures, each rate followed by `<rate>_lower` and
 * `<rate>_upper`, read from the interval CDC nested in the rate's cell and null when it sent
 * none. Every row of a table carries the same keys, so the first row names the columns of all
 * of them.
 *
 * @param body - Full XML response text.
 * @param columns - Ordered cell keys: `dimensionCount` dimensions followed by measures.
 * @param dimensionCount - Number of leading dimension columns (for rowspan reconstruction).
 * @returns Parsed rows, resolved caveats/footnotes, and the status tokens found in measure cells.
 */
export function parseDataTable(
  body: string,
  columns: string[],
  dimensionCount: number,
): ParsedTable {
  const measureCount = columns.length - dimensionCount;
  const codes = codeSources(columns, dimensionCount);

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
  /** Each dimension slot's latest cell: its label, and its attributes for the codes beside it. */
  const carried: string[] = new Array<string>(dimensionCount).fill('');
  const carriedAttrs: string[] = new Array<string>(dimensionCount).fill('');

  for (const rowInner of elementContents(tableInner, 'r', 'exact')) {
    const cells = rowCells(rowInner);
    // Skip subtotal/total rows (defensive — absent when O_show_totals=false):
    // they carry a `dt` cell or a leading `c=` colspan marker.
    const first = cells[0]?.attrs;
    const isTotalsRow =
      cells.some((c) => attr(c.attrs, 'dt') !== undefined) ||
      (first !== undefined && attr(first, 'c') !== undefined && attr(first, 'l') === undefined);
    if (isTotalsRow) continue;
    if (cells.length < measureCount) continue;

    // Leading cells are the dimension labels present on this row; trailing `measureCount` are measures.
    const dimCells = cells.slice(0, cells.length - measureCount);
    const measureCells = cells.slice(cells.length - measureCount);
    if (dimCells.length > dimensionCount) continue; // anomalous — no mortality database emits it

    // Rowspan carry: present dimension cells fill the trailing dimension slots; the
    // leading slots (omitted due to rowspan) keep the previous row's value, codes included.
    const present = dimCells.length;
    for (let j = 0; j < present; j++) {
      const attrs = dimCells[j]?.attrs ?? '';
      carried[dimensionCount - present + j] = dimensionLabel(attr(attrs, 'l'));
      carriedAttrs[dimensionCount - present + j] = attrs;
    }

    const row: WonderRow = {};
    for (let i = 0; i < dimensionCount; i++) {
      const key = columns[i];
      if (key !== undefined) row[key] = carried[i] ?? '';
    }
    for (const [key, { slot, attribute }] of codes) {
      row[key] = dimensionCode(carriedAttrs[slot] ?? '', attribute);
    }
    for (let m = 0; m < measureCount; m++) {
      const key = columns[dimensionCount + m];
      if (key === undefined) continue;
      const cell = measureCells[m];
      const { value, token } = parseMeasure(attr(cell?.attrs ?? '', 'v'));
      row[key] = value;
      if (token !== null) cellNotes.push({ row: rows.length, column: key, token });
      if (RATE_MEASURES.has(key)) {
        const bounds = parseInterval(cell?.interval);
        row[`${key}_lower`] = bounds?.lower ?? null;
        row[`${key}_upper`] = bounds?.upper ?? null;
      }
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
