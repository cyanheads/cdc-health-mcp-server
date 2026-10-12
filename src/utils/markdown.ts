/**
 * @fileoverview Markdown rendering helpers shared by tool `format()` functions and enrichment
 * trailer renders. Every caller- or upstream-sourced string a tool interpolates into
 * `content[]` passes through one of these at the render boundary, so it displays as the
 * literal text `structuredContent` carries; `structuredContent` itself is never escaped.
 * @module utils/markdown
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * Where an escaped string sits in the surrounding Markdown, which decides what can turn it
 * into something other than text:
 * - `inline` — inside a line the server wrote (a table cell, after a `**Label:**`, between
 *   quotes). Only inline constructs apply.
 * - `line` — opening a line of its own (a description under a metadata line, a blockquote
 *   line). A leading marker can also open a block — heading, list, quote, thematic break,
 *   setext underline, indented code.
 * - `heading` — the text of an ATX heading (`### ${text}`). A trailing `#` run would be
 *   stripped as the heading's closing sequence.
 */
export type MarkdownSlot = 'inline' | 'line' | 'heading';

/** CR, LF, and CRLF — the three line endings CommonMark recognizes. */
const LINE_ENDING = /\r\n|\r|\n/g;

/**
 * One candidate per match: a character that is always escaped, an underscore run (escaped
 * unless intraword), a `<` (escaped when it opens markup), or a `&` (escaped when it opens an
 * entity reference). `|` is always escaped: inside a GFM table it would split the row, and on
 * a line of its own it can turn the line above into a table header.
 */
const SPECIAL = /[\\`*~[\]|]|_+|<|&/g;

/** A letter or digit in any script — the neighbours that make an underscore run intraword. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * What can follow `<` to open raw HTML — a tag, closing tag, comment, declaration, or
 * processing instruction — or a URI autolink, whose scheme starts with a letter.
 */
const TAG_OPENER = /[A-Za-z/!?]/;

/** The local part and `@` of an email autolink (`<1@example.com>`), which may open with a digit. */
const EMAIL_AUTOLINK = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@/y;

/** A named, decimal, or hexadecimal entity reference that CommonMark would decode. */
const ENTITY_REFERENCE = /&(?:#[0-9]{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y;

/**
 * A marker that opens a block when it leads a line: ATX heading, blockquote, bullet list,
 * thematic break or setext underline (`-`, `+`, `=`; `*` and `_` are escaped anywhere), or an
 * ordered-list marker, whose delimiter is the character escaped (`2000\.`, `1\)`).
 */
const LEADING_BLOCK_MARKER = /^(?:[#>+=-]|(\d{1,9})([.)]))/;

/** A trailing `#` run that ATX would read as the heading's closing sequence. */
const CLOSING_SEQUENCE = /(^|[ \t])(#+[ \t]*)$/;

/**
 * A scheme URL as GFM would autolink it bare: up to whitespace, a control character, `<`, `>`,
 * or a character a table or code span would claim first (`|`, backtick). GFM takes a bare URL's
 * characters literally, backslashes included, so an escape inside one would land in the link
 * target.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters end a CommonMark autolink
const SCHEME_URL = /https?:\/\/[^\s\x00-\x1f\x7f<>|`]+/gi;

/** How far a GFM bare autolink reaches: to the next whitespace or `<`. */
const AUTOLINK_RUN = /[^\s<]*/y;

/** True when the sticky `regex` matches `text` starting exactly at `index`. */
function matchesAt(regex: RegExp, text: string, index: number): boolean {
  regex.lastIndex = index;
  return regex.test(text);
}

/**
 * Cut `url` back to the address GFM's autolink extension would link: trailing `?!.,:*_~'"` off,
 * a `;` off along with the `&name` it closes, and a `)` off while the URL holds more `)` than `(`.
 */
function linkedPart(url: string): string {
  let end = url.length;
  let unbalanced = url.split(')').length - url.split('(').length;
  while (end > 0) {
    const last = url[end - 1] ?? '';
    if (last === ';') {
      let start = end - 1;
      while (start > 0 && /[A-Za-z0-9]/.test(url[start - 1] ?? '')) start--;
      end = url[start - 1] === '&' && start < end - 1 ? start - 1 : end - 1;
    } else if (`?!.,:*_~'"`.includes(last)) {
      end--;
    } else if (last === ')' && unbalanced > 0) {
      end--;
      unbalanced--;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

/** Escape every inline construct in `text`; its own edges count as non-word. */
function escapeSegment(text: string): string {
  return text.replace(SPECIAL, (match: string, offset: number) => {
    const next = offset + match.length;
    if (match[0] === '_') {
      const intraword = WORD_CHAR.test(text[offset - 1] ?? '') && WORD_CHAR.test(text[next] ?? '');
      return intraword ? match : match.replaceAll('_', '\\_');
    }
    if (match === '<') {
      const opensMarkup =
        TAG_OPENER.test(text[next] ?? '') || matchesAt(EMAIL_AUTOLINK, text, next);
      return opensMarkup ? '\\<' : '<';
    }
    if (match === '&') return matchesAt(ENTITY_REFERENCE, text, offset) ? '\\&' : '&';
    return `\\${match}`;
  });
}

/**
 * Escape `text`, emitting a scheme URL as a CommonMark autolink (`<https://…>`, whose content a
 * renderer takes literally) when an escape would otherwise land inside its GFM bare-autolink
 * run. Every other URL stays bare and byte-identical.
 */
function escapeInline(text: string): string {
  let escaped = '';
  let last = 0;
  let runEnd = -1;
  let runEscapes = false;
  for (const match of text.matchAll(SCHEME_URL)) {
    const url = linkedPart(match[0]);
    if (url.length <= match[0].indexOf('//') + 2) continue;
    /**
     * GFM's autolink runs on to the next whitespace or `<`. A URL stays bare when the escaper
     * would leave its run alone and the run ends at whitespace — an escaped `<` would carry the
     * run on through its backslash. A later URL in the same run shares its verdict, so each run
     * is scanned once.
     */
    if (match.index >= runEnd) {
      AUTOLINK_RUN.lastIndex = match.index;
      const run = AUTOLINK_RUN.exec(text)?.[0] ?? '';
      runEnd = match.index + run.length;
      runEscapes = text[runEnd] === '<' || escapeSegment(run) !== run;
    }
    if (!runEscapes) continue;
    escaped += `${escapeSegment(text.slice(last, match.index))}<${url}>`;
    last = match.index + url.length;
  }
  return escaped + escapeSegment(text.slice(last));
}

/**
 * Backslash-escape the characters in `value` that would otherwise render as Markdown, so it
 * reads back as the literal text under a CommonMark/GFM renderer.
 *
 * Only characters that change rendering are touched, which keeps identifiers and figures
 * byte-identical: `data_value_type`, `-5`, `< 1 year`, `<5`, `85+ years`. The backslash itself
 * is always escaped — leaving it would let `[x\](javascript:…)` close a link the escaper meant
 * to defuse. An underscore run is escaped unless a letter or digit sits on both sides of it,
 * since only then is it intraword and unable to open or close emphasis; a value's own edges
 * count as non-word, because the template around it is not known here. `<` is escaped where it
 * opens raw HTML or an autolink, `&` where it opens an entity reference. Line endings are
 * flattened to a space, so a value can never end the line it was interpolated into.
 *
 * GFM's bare-URL and bare-email autolinks are not suppressed: a URL in a value still renders
 * as a link to the address it spells. GFM takes a bare URL's characters literally, so a scheme
 * URL whose autolink run holds something the escaper would touch (`-_`, a trailing `*`) is
 * emitted as a CommonMark autolink, `<https://…>`, whose content is literal too; any other URL
 * stays bare and byte-identical. A bare `www.` host has no scheme to anchor that form and is
 * escaped like the text around it.
 *
 * @param value - Raw caller or upstream text.
 * @param slot - Where the text sits in the surrounding Markdown (default `inline`).
 * @returns The text, safe to interpolate into that slot.
 */
export function escapeMarkdownText(value: string, slot: MarkdownSlot = 'inline'): string {
  let text = value.replace(LINE_ENDING, ' ');
  if (slot === 'line') text = text.trimStart();

  const escaped = escapeInline(text);

  if (slot === 'line') {
    return escaped.replace(LEADING_BLOCK_MARKER, (marker, digits?: string, delimiter?: string) =>
      digits ? `${digits}\\${delimiter}` : `\\${marker}`,
    );
  }
  if (slot === 'heading') return escaped.replace(CLOSING_SEQUENCE, '$1\\$2');
  return escaped;
}

/**
 * Make an upstream string safe to interpolate into a single markdown table cell.
 *
 * Line breaks collapse to single spaces along with the whitespace around them (a raw newline
 * terminates the row) and the value is trimmed; then everything Markdown would act on is
 * escaped as {@link escapeMarkdownText} escapes it inline, `|` included, so a value can neither
 * split its row into extra columns nor render as emphasis, a link, or HTML. The normalization
 * splits on line breaks and trims each line, which keeps it linear in the length of the value.
 *
 * @param value - Raw text destined for a table cell.
 * @returns The text, single-line and escaped.
 */
export function escapeTableCell(value: string): string {
  const line = value
    .split(/[\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
  return escapeMarkdownText(line);
}

/**
 * Wrap `value` in an inline code span that reads back byte-identical, sized by the framework's
 * `markdown().inlineCode()`: a fence one backtick longer than the longest backtick run in the
 * value, padded when a backtick or a space pair touches an end. Line endings are flattened to
 * spaces first — a blank line inside a span would end the paragraph and leave the span open.
 *
 * @param value - Text to show verbatim, e.g. a query echo.
 * @returns The span, delimiters included.
 */
export function markdownCodeSpan(value: string): string {
  return markdown().inlineCode(value.replace(LINE_ENDING, ' ')).build();
}

/**
 * {@link markdownCodeSpan} for a table cell. GFM splits a row on every unescaped `|` before it
 * parses code spans, so each pipe in the span is escaped; the table unescapes it again and the
 * span reads back with the pipe in place.
 *
 * @param value - Text to show verbatim in a cell, e.g. a column field name.
 * @returns The span, delimiters included, safe inside a table row.
 */
export function markdownTableCodeSpan(value: string): string {
  return markdownCodeSpan(value).replaceAll('|', '\\|');
}

/**
 * Render text as a blockquote whose every line is quoted and escaped. The text is split on the
 * line endings {@link escapeMarkdownText} flattens, so a line break inside a caller's value — a
 * blank line especially — cannot end the quote and let what follows render as a heading or a
 * list; each line is escaped in the `line` slot, so nothing opens a block inside the quote.
 *
 * @param text - Plain text, e.g. an enrichment `notice`.
 * @returns The blockquote Markdown, one `>` line per input line.
 */
export function markdownBlockquote(text: string): string {
  return text
    .split(LINE_ENDING)
    .map((line) => {
      const escaped = escapeMarkdownText(line, 'line');
      return escaped === '' ? '>' : `> ${escaped}`;
    })
    .join('\n');
}
