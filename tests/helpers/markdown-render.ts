/**
 * @fileoverview Renders tool `content[]` Markdown through a real CommonMark/GFM renderer so
 * tests can assert what a `content[]`-only client actually displays — which elements a string
 * produced and the text it reads back as — rather than how the escaped source looks.
 * @module tests/helpers/markdown-render
 */

import { marked } from 'marked';

/** Render GFM to HTML, synchronously. */
export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/** Decode the five entity references `marked` emits for text it escaped. */
function decodeRendered(html: string): string {
  return html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** The text a rendered fragment reads back as: every element removed, entities decoded. */
export function readBack(html: string): string {
  return decodeRendered(html.replace(/<[^>]+>/g, ''));
}

/**
 * Elements in `html` beyond the container a test expects, named by tag. A bare URL or email
 * autolink (an `<a>` whose percent-decoded href is its own text, or `mailto:` plus its text)
 * is GFM's autolink extension spelling out an address the value itself contains, rather than
 * a construct the server emitted, and is reported only when it points somewhere its text does
 * not say. A backslash in its target is reported too: GFM takes a bare URL's characters
 * literally, so a `\` there is an escape the server let land inside the address. Test values
 * therefore carry no backslash inside an address.
 */
export function strayElements(html: string, allowed: readonly string[]): string[] {
  const stray: string[] = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>([^<]*)/g)) {
    const [, tag = '', attrs = '', text = ''] = match;
    if (allowed.includes(tag)) continue;
    if (tag === 'a') {
      const href = attrs.match(/href="([^"]*)"/)?.[1] ?? '';
      const target = decodeURI(decodeRendered(href));
      const shown = decodeRendered(text);
      const spelled = target === shown || target === `mailto:${shown}`;
      if (spelled && !target.includes('\\')) continue;
    }
    stray.push(tag);
  }
  return stray;
}

/** Inner HTML of every rendered table body cell, in document order. */
export function renderedCells(html: string): string[] {
  return [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '');
}

/** All text blocks of a `CallToolResult`'s `content[]`, joined the way a client concatenates them. */
export function contentText(result: { content?: unknown }): string {
  return ((result.content ?? []) as { type: string; text?: string }[])
    .map((block) => block.text ?? '')
    .join('');
}
