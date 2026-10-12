/**
 * @fileoverview Plain-text conversion for upstream prose that arrives as markup.
 * Socrata catalog descriptions and CDC WONDER caveats both carry HTML tags and entity
 * references; both reach the caller as text, so both need the same one-pass conversion.
 * Also the blank-string test (`nonBlank`) the Socrata request builders and tools share.
 * Pure module (no framework imports).
 * @module utils/text
 */

/**
 * Entity names decoded to their character. Anything outside this set is left verbatim —
 * an unrecognized name is more likely prose than an entity, and passing it through is
 * lossless where guessing is not.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  deg: '°',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  times: '×',
  trade: '™',
};

/**
 * One entity reference: a named one, or a decimal or hexadecimal character reference.
 * The trailing semicolon is required, so a bare `&` in prose is never mistaken for the
 * start of one.
 */
const ENTITY = /&(#[Xx][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/**
 * A tag the markup leaves open at its end, as the Discovery API cuts descriptions mid-anchor
 * (`<a href="https://…`): a comment opener, or a tag name — bare, or carrying an attribute
 * assignment — that runs to the end of the text. Prose that merely looks like an opener
 * (`x<y in women`, `<b grade`) assigns no attribute and keeps its text.
 */
const UNCLOSED_TAG = /<(?:!--|\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][-\w:.]*\s*=[^<]*)?$)/;

/**
 * Characters of the dataset-level description a metadata response carries before it is cut. The
 * description repeats on every column page, and column paging cannot shrink it: at 32,394
 * characters, `ua7e-t2fy`'s is 98% of a two-column response. Only a few dozen catalog
 * descriptions exceed this (the median is about 1,075), so the cap changes only those.
 */
export const DATASET_DESCRIPTION_CAP = 4000;

/** {@link DATASET_DESCRIPTION_CAP} as the thousands-separated figure the tool text quotes. */
export const DATASET_DESCRIPTION_CAP_TEXT = DATASET_DESCRIPTION_CAP.toLocaleString('en-US');

/** A token GFM renders as a link: a scheme URL, a `www.` host, or an email address. */
const AUTOLINKED = /:\/\/|(?:^|\W)www\.|@[\w-]+\./i;

/** True for the first half of a UTF-16 surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Index where the whitespace-delimited token ending at `end` begins. */
function tokenStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) start--;
  return start;
}

/**
 * A code point `String.fromCodePoint` will accept and JSON will survive. Above U+10FFFF it
 * throws a `RangeError`; in the surrogate range it yields an unpaired code unit that Bun
 * round-trips happily but a strict JSON consumer (`jq`) rejects for the whole frame. U+0000
 * is excluded as well — nothing upstream means it, and it has no business in a tool result.
 */
function isEmittableCodePoint(code: number): boolean {
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}

/**
 * Decode entity references in a single left-to-right pass.
 *
 * The pass is what matters. Chaining one `replaceAll` per entity resolves `&amp;` before
 * `&lt;`, so `&amp;lt;` decodes twice and becomes `<` — markup manufactured from text a
 * publisher escaped precisely so it would not be markup. Scanning once and never re-reading
 * a replacement leaves it as the literal `&lt;` it was written to be. A reference this
 * function cannot decode — an unknown name, an out-of-range or surrogate code point — is
 * returned untouched rather than approximated.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (reference, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body] ?? reference;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    return isEmittableCodePoint(code) ? String.fromCodePoint(code) : reference;
  });
}

/**
 * Replace every tag with a space, and drop a tag the markup leaves open at its end.
 *
 * A tag runs from a `<` to the next `>`, as `<[^>]*>` would match it. Once a `<` finds no `>`
 * after it, no later `<` can either, so the scan stops there: the rest of the markup holds no
 * complete tag. If a tag is left open at the very end of that rest — the Discovery API returns
 * descriptions cut off mid-anchor, ending `<a href="https://…` — everything from that opener on
 * is a fragment of markup, not text, and is dropped. An opener only counts as cut open when a
 * comment starts there or a tag name, bare or carrying an attribute assignment, runs to the
 * end; prose with a `<` in it (`<5`, `x<y in women`, `<b grade or better`) stays. Linear in
 * the length of the markup.
 */
function replaceTags(markup: string): string {
  let out = '';
  let last = 0;
  for (let open = markup.indexOf('<'); open !== -1; open = markup.indexOf('<', last)) {
    const close = markup.indexOf('>', open + 1);
    if (close === -1) {
      const rest = markup.slice(last);
      const fragment = UNCLOSED_TAG.exec(rest);
      return fragment ? `${out}${rest.slice(0, fragment.index)} ` : out + rest;
    }
    out += `${markup.slice(last, open)} `;
    last = close + 1;
  }
  return out + markup.slice(last);
}

/**
 * Replace every tag with a space and decode entity references once, leaving whitespace as
 * it falls. The building block of `toPlainText`, exported for callers that convert a
 * document in segments and collapse whitespace over the assembled result.
 *
 * Tags come off *before* decoding, never after. Decoding first would turn an escaped
 * `&lt;script&gt;` into a real tag for the stripper to eat, silently deleting text the
 * publisher intended to show. A tag left unclosed at the end comes off too (see
 * `replaceTags`).
 */
export function stripAndDecode(markup: string): string {
  return decodeEntities(replaceTags(markup));
}

/**
 * `value` when it holds a non-whitespace character, `undefined` otherwise. A blank or
 * whitespace-only optional string is unset — what a form client sends for a field left empty —
 * so it goes neither upstream nor into an echo. A value with text in it is returned as sent,
 * surrounding whitespace included.
 */
export function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && /\S/.test(value) ? value : undefined;
}

/** Collapse runs of whitespace to a single space and trim the ends. Decodes nothing. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Render markup-bearing upstream text as plain text: tags become spaces, entity references
 * are decoded once, and runs of whitespace collapse to a single space.
 */
export function toPlainText(markup: string): string {
  return collapseWhitespace(stripAndDecode(markup));
}

/**
 * Cut plain text to at most `maxChars` characters and mark the cut with `…`, without leaving
 * a link to an address the text never named. The one cut rule for dataset descriptions.
 *
 * A cut inside a URL (a scheme URL, a `www.` host, or an email address) drops the partial
 * address: a GFM client autolinks bare URLs, and `https://www.cdc.gov/nch` links to a page
 * that does not exist. A URL the cut lands right after is kept and set off from the ellipsis
 * by a space, since GFM extends a bare URL through a directly-attached `…` (`%E2%80%A6`). Any
 * other token is cut at the limit, as before. A cut that would split a surrogate pair moves
 * back one unit — a lone surrogate makes a strict JSON consumer reject the whole frame.
 *
 * Takes text already converted with `toPlainText`, so the limit is spent on visible text and
 * no tag or entity reference can be split. Markdown escaping happens later, at the render
 * boundary, so no escape sequence is split either.
 *
 * @param text - Plain text.
 * @param maxChars - Most characters kept before the ellipsis.
 * @returns `text` unchanged when it fits, otherwise the cut text ending in `…`.
 */
export function truncatePlainText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = isHighSurrogate(text.charCodeAt(maxChars - 1)) ? maxChars - 1 : maxChars;
  const start = tokenStart(text, end);
  const cutsToken = !/\s/.test(text[end] ?? '');
  if (cutsToken && AUTOLINKED.test(text.slice(start, end))) end = start;

  const kept = text.slice(0, end).trimEnd();
  const lastToken = kept.slice(tokenStart(kept, kept.length));
  return `${kept}${AUTOLINKED.test(lastToken) ? ' ' : ''}…`;
}
