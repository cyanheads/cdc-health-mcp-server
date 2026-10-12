/**
 * @fileoverview Tests for the shared plain-text conversion used by Socrata catalog
 * descriptions and CDC WONDER caveat text.
 * @module tests/utils/text
 */

import { describe, expect, it } from 'vitest';
import { decodeEntities, nonBlank, toPlainText, truncatePlainText } from '@/utils/text.js';
import { expectLinearCost } from '../helpers/cpu-cost.js';

describe('nonBlank', () => {
  it.each([undefined, '', ' ', '\t\n ', '\u00a0'])('reads %j as unset', (value) => {
    expect(nonBlank(value)).toBeUndefined();
  });

  it('returns a value with text in it exactly as sent', () => {
    expect(nonBlank(' year=2020 ')).toBe(' year=2020 ');
    expect(nonBlank('0')).toBe('0');
  });
});

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

  it('drops an anchor to its text, since a Socrata description has no link surface', () => {
    /**
     * WONDER turns its caveat anchors into Markdown links in its own parser; this conversion
     * is shared with Socrata descriptions and must keep rendering an anchor as bare text.
     */
    expect(toPlainText('See <a href="/wonder/help/x.html#A b" onclick="f()">docs</a>.')).toBe(
      'See docs .',
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
    /** The assertion is correctness — the runtime is the guard. */
    const body = '<span>Deaths &amp; births. </span>'.repeat(20_000);
    const text = toPlainText(body);
    expect(text.startsWith('Deaths & births.')).toBe(true);
    expect(text.split('Deaths & births.')).toHaveLength(20_001);
  });

  it('keeps a `<` that opens no tag', () => {
    expect(toPlainText('rates <5 per 100k, p<0.05, ages < 1 year, x<')).toBe(
      'rates <5 per 100k, p<0.05, ages < 1 year, x<',
    );
  });

  it('drops a trailing tag the markup leaves unclosed', () => {
    /** The Discovery API cuts `jgk8-6dpn` and `n8mc-b4w4` mid-anchor, near 4,000 characters. */
    expect(
      toPlainText(
        '<p>Archived datasets can be found here:</p> <a href="https://data.cdc.gov/Public-Health-Surveillance/United-States-COVID-19-County-Level-of-Community-T',
      ),
    ).toBe('Archived datasets can be found here:');
    expect(toPlainText('Statement (<a href="https://cdn.ymaws.com/www.cste.org/ps/Interim')).toBe(
      'Statement (',
    );
    expect(toPlainText('Text then </spa')).toBe('Text then');
    expect(toPlainText('Text then <!-- note')).toBe('Text then');
    expect(toPlainText('Cut <a')).toBe('Cut');
    expect(toPlainText('Cut <a class="x" href=')).toBe('Cut');
  });

  it('keeps prose that only looks like a tag opener when no `>` follows', () => {
    expect(toPlainText('ratio x<y in women')).toBe('ratio x<y in women');
    expect(toPlainText('scores of <b grade or better')).toBe('scores of <b grade or better');
    expect(toPlainText('less than <a hundred cases')).toBe('less than <a hundred cases');
    expect(toPlainText('<b>Rates</b> for x<y in women')).toBe('Rates for x<y in women');
  });

  describe('cost on worst-case input', () => {
    const shapes: Record<string, (n: number) => string> = {
      'repeated tag opener with no closer': (n) => '<a'.repeat(n / 2),
      'repeated attribute assignment with no closer': (n) => '<a x='.repeat(n / 5),
      'one opener before a long attribute run': (n) => `<a x=${'y'.repeat(n - 5)}`,
      'one opener before a long name and a word': (n) => `<a${'-'.repeat(n - 4)} b`,
      'openers each before a long unassigned attribute': (n) =>
        `<a ${'x'.repeat(n / 4)} `.repeat(4),
    };

    it.each(Object.entries(shapes))('stays linear on %s', (_name, build) => {
      expectLinearCost(build, toPlainText);
    });
  });
});

describe('truncatePlainText', () => {
  it('returns text within the limit unchanged', () => {
    expect(truncatePlainText('short text', 300)).toBe('short text');
    expect(truncatePlainText('x'.repeat(300), 300)).toBe('x'.repeat(300));
  });

  it('cuts ordinary prose at the limit and appends an ellipsis', () => {
    expect(truncatePlainText('abcdefghij klmnop', 5)).toBe('abcde…');
  });

  it('drops a URL the cut lands inside, along with the space before it', () => {
    expect(truncatePlainText('see https://www.iqvia.com/insights for more', 20)).toBe('see…');
    expect(truncatePlainText('see www.cdc.gov/nchs/data for more', 12)).toBe('see…');
    expect(truncatePlainText('(https://www.iqvia.com/insights)', 20)).toBe('…');
  });

  it('keeps a URL the cut lands right after and sets the ellipsis off with a space', () => {
    expect(truncatePlainText('see https://www.iqvia.com and more', 25)).toBe(
      'see https://www.iqvia.com …',
    );
  });

  it('treats an email address as a URL: dropped when cut inside, set off when cut after', () => {
    expect(truncatePlainText('contact someone@cdc.gov for help', 20)).toBe('contact…');
    expect(truncatePlainText('mail a@cdc.gov now', 14)).toBe('mail a@cdc.gov …');
  });

  it('keeps a whole URL followed by a cut word, ending on the word', () => {
    expect(truncatePlainText('https://www.cdc.gov is where data lives', 23)).toBe(
      'https://www.cdc.gov is…',
    );
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    expect(truncatePlainText(`ab💩cd`, 3)).toBe('ab…');
    expect(truncatePlainText(`ab💩cd`, 4)).toBe('ab💩…');
  });

  describe('cost on worst-case input', () => {
    const shapes: Record<string, (n: number) => string> = {
      'one unbroken token': (n) => 'a'.repeat(n),
      'one unbroken URL': (n) => `https://${'a'.repeat(n - 8)}`,
      'many short tokens': (n) => 'ab '.repeat(n / 3),
      'repeated tag opener with no closer': (n) => '<a'.repeat(n / 2),
      'tag openers before digits': (n) => '<1'.repeat(n / 2),
    };

    it.each(Object.entries(shapes))('stays linear on %s', (_name, build) => {
      expectLinearCost(build, (input) => truncatePlainText(toPlainText(input), input.length / 2));
    });
  });
});
