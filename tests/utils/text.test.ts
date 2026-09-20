/**
 * @fileoverview Tests for the shared plain-text conversion used by Socrata catalog
 * descriptions and CDC WONDER caveat text.
 * @module tests/utils/text
 */

import { describe, expect, it } from 'vitest';
import { decodeEntities, toPlainText } from '@/utils/text.js';

describe('decodeEntities', () => {
  it('decodes the named references CDC prose actually carries', () => {
    expect(
      decodeEntities('Deaths &amp; births &lt;1 &gt;65 &quot;raw&quot; &apos;90s &nbsp;'),
    ).toBe('Deaths & births <1 >65 "raw" \'90s  ');
    expect(decodeEntities('2019&ndash;2020 &mdash; see notes&hellip;')).toBe(
      '2019–2020 — see notes…',
    );
  });

  it('decodes decimal and hexadecimal character references', () => {
    expect(decodeEntities('100&#37; &#8212; &#x2014; &#x1F4A9;')).toBe('100% — — 💩');
  });

  it('runs one left-to-right pass and never re-reads what it wrote', () => {
    /**
     * The defect a chained per-entity decode produces: `&amp;` resolves first, the `&lt;` it
     * exposes is then resolved too, and text a publisher escaped so it would not be markup
     * becomes markup.
     */
    expect(decodeEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('peels exactly one level off a doubly-escaped reference', () => {
    /** Second level: `&amp;amp;lt;` must land on `&amp;lt;`, not on `&lt;` and not on `<`. */
    expect(decodeEntities('&amp;amp;lt;')).toBe('&amp;lt;');
    expect(decodeEntities(decodeEntities('&amp;amp;lt;'))).toBe('&lt;');
  });

  it('leaves an unknown name, a bare ampersand, and a semicolon-less name alone', () => {
    expect(decodeEntities('R&D; &notareal; A&B &amp')).toBe('R&D; &notareal; A&B &amp');
  });

  it('leaves an out-of-range numeric reference as text rather than throwing', () => {
    /** `String.fromCodePoint` raises a RangeError above U+10FFFF. */
    expect(() => decodeEntities('&#x110000;')).not.toThrow();
    expect(decodeEntities('&#x110000; and &#1114112;')).toBe('&#x110000; and &#1114112;');
  });

  it('leaves a surrogate reference as text, in either case and either half of the range', () => {
    expect(decodeEntities('&#xD800; &#xdfff; &#55296;')).toBe('&#xD800; &#xdfff; &#55296;');
  });

  it('emits no unpaired surrogate code unit for any reference in the surrogate range', () => {
    /**
     * Bun round-trips one through JSON.stringify/parse without complaint; `jq` rejects the
     * whole frame as an invalid surrogate pair escape. The runtime's tolerance is not the bar.
     */
    for (const code of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      const decoded = decodeEntities(`&#x${code.toString(16)};`);
      for (const char of decoded) {
        const unit = char.charCodeAt(0);
        expect(unit >= 0xd800 && unit <= 0xdfff).toBe(false);
      }
    }
  });

  it('leaves a NUL reference as text', () => {
    expect(decodeEntities('&#0; &#x0;')).toBe('&#0; &#x0;');
  });
});

describe('toPlainText', () => {
  it('removes tags, decodes once, and collapses the whitespace left behind', () => {
    const markup =
      '</p><p style="margin:0in;vertical-align:baseline;"><strong><em>' +
      `<span style='font-size:15px;font-family:"Calibri",sans-serif;'>` +
      'After October 13, 2022, this dataset will no longer be updated.</span></em></strong>';
    expect(toPlainText(markup)).toBe(
      'After October 13, 2022, this dataset will no longer be updated.',
    );
  });

  it('separates text the markup kept apart rather than gluing it together', () => {
    expect(toPlainText('Line one<br/>Line two')).toBe('Line one Line two');
  });

  it('strips tags before decoding, so an escaped tag survives as text', () => {
    /**
     * Decoding first would turn `&lt;script&gt;` into a real element for the stripper to eat,
     * silently deleting text the publisher meant to show.
     */
    expect(toPlainText('Use &lt;script&gt; carefully')).toBe('Use <script> carefully');
    expect(toPlainText('<b>Use</b> &amp;lt;script&amp;gt; carefully')).toBe(
      'Use &lt;script&gt; carefully',
    );
  });

  it('reads through a deeply nested block, not just its outermost element', () => {
    const nested =
      '<div><section><ul><li><span><em>Cases</em> by <b>age group</b></span></li></ul></section></div>';
    expect(toPlainText(nested)).toBe('Cases by age group');
  });

  it('renders markup with no text in it as the empty string', () => {
    expect(toPlainText('<p></p>\n  <br/>')).toBe('');
    expect(toPlainText('')).toBe('');
  });

  it('scans a long description in one pass', () => {
    /**
     * A per-element scan from position zero is quadratic; at this size it would not finish
     * inside the test timeout. The assertion is correctness — the runtime is the guard.
     */
    const body = '<span>Deaths &amp; births. </span>'.repeat(20_000);
    const text = toPlainText(body);
    expect(text.startsWith('Deaths & births.')).toBe(true);
    expect(text.split('Deaths & births.')).toHaveLength(20_001);
  });
});
