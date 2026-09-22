/**
 * @fileoverview Plain-text conversion for upstream prose that arrives as markup.
 * Socrata catalog descriptions and CDC WONDER caveats both carry HTML tags and entity
 * references; both reach the caller as text, so both need the same one-pass conversion.
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

/** Every HTML/XML tag, including the unclosed fragments CDC descriptions open with. */
const TAG = /<[^>]*>/g;

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
 * Replace every tag with a space and decode entity references once, leaving whitespace as
 * it falls. The building block of `toPlainText`, exported for callers that convert a
 * document in segments and collapse whitespace over the assembled result.
 *
 * Tags come off *before* decoding, never after. Decoding first would turn an escaped
 * `&lt;script&gt;` into a real tag for the stripper to eat, silently deleting text the
 * publisher intended to show.
 */
export function stripAndDecode(markup: string): string {
  return decodeEntities(markup.replace(TAG, ' '));
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
