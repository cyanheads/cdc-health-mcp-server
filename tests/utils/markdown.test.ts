/**
 * @fileoverview Tests for the Markdown rendering helpers every `format()` and enrichment
 * trailer interpolates upstream and caller text through. Rendering is checked by round-trip
 * through a real CommonMark/GFM renderer (`marked`), not by inspecting the escaped string.
 * @module tests/utils/markdown
 */

import { describe, expect, it } from 'vitest';
import {
  escapeMarkdownText,
  escapeTableCell,
  markdownBlockquote,
  markdownCodeSpan,
  markdownTableCodeSpan,
} from '@/utils/markdown.js';
import { expectLinearCost } from '../helpers/cpu-cost.js';
import {
  readBack,
  renderedCells,
  renderMarkdown,
  strayElements,
} from '../helpers/markdown-render.js';

/** A one-row, one-column table holding `cell`. */
const oneCellTable = (cell: string) => `| h |\n| --- |\n| ${cell} |`;

/** Line endings as a code span or one rendered line reads them: each becomes a space. */
const flat = (value: string) => value.replace(/\r\n|\r|\n/g, ' ');

/**
 * Strings built to turn into something other than text: every inline construct CommonMark
 * and GFM define, the block starts that can open a line, and the cross-character tricks an
 * escaper that inserts backslashes walks into.
 */
const HOSTILE = [
  '<b>literal</b> *emphasis* [label](https://example.com)',
  '$select=state, count(*) as n&$having=count(*) > 5',
  '_x_ __y__ *z* **w** ~del~ ~~del~~ `code` ``co`de``',
  '![img](x.png) [ref][1] [shortcut] [^note]',
  '[x\\](javascript:alert(1)) \\[y] ends with \\',
  '&amp; &#169; &#x41; &copy; AT&T &bogus',
  '<!-- comment --> <?pi?> <!DOCTYPE x> <![CDATA[x]]> </close> <a href="x">',
  '<https://example.com> <1@example.com> <mailto:x@y.z>',
  'a | b | c',
  '2000. not a list',
  '1) not a list',
  '# not a heading',
  '###### nor this',
  '> not a quote',
  '- not a list',
  '+ not a list',
  '* not a list',
  '---',
  '===',
  '***',
  '-|-|-',
  '```fence',
  '~~~fence',
  '<div>html block</div>',
  '<script>alert(1)</script>',
  '[ref]: https://example.com',
  '    indented four spaces',
  'Cases by week #',
  'Trailing ##   ',
  '#',
  'line1\nline2\r\n\r\n# injected\r- item',
];

/** Values that must render exactly as written, escaper or not. */
const PLAIN = [
  'data_value_type',
  'snake_case_name_2',
  'café_au_lait',
  '-5',
  '< 1 year',
  '<5 deaths',
  'p<0.05',
  '85+ years',
  '2025 (provisional)',
  'Rate (per 100,000)',
  '1,234',
  'a = b',
  'x > y',
  '#1 cause',
];

describe('escapeTableCell — pipe and line-break handling (#24)', () => {
  it('keeps a pipe inside its cell instead of splitting the row', () => {
    const html = renderMarkdown(`| a | b |\n| --- | --- |\n| ${escapeTableCell('x|y')} | z |`);
    expect(renderedCells(html)).toEqual(['x|y', 'z']);
  });

  it('collapses every line break, with the whitespace around it, to one space', () => {
    expect(escapeTableCell('line1\r\n  line2\n\nline3\rline4')).toBe('line1 line2 line3 line4');
    expect(renderedCells(renderMarkdown(oneCellTable(escapeTableCell('line1\n\nline2'))))).toEqual([
      'line1 line2',
    ]);
  });

  it.each([
    ['', ''],
    ['  padded \n', 'padded'],
    [' \t\u00a0', ''],
    ['\n', ''],
    [' \n \t\n\u00a0 ', ''],
    ['  a  ', 'a'],
    ['\t a \t\n', 'a'],
    ['a \n \t \n b', 'a b'],
    ['a\u00a0\n\u00a0b', 'a b'],
    ['a\u2028\nb', 'a b'],
    ['a \n \u2028 \n b', 'a b'],
    ['a  b\nc\t\td', 'a  b c\t\td'],
  ])('normalizes %j to %j, keeping whitespace inside a line', (value, expected) => {
    expect(escapeTableCell(value)).toBe(expected);
  });

  it('normalizes a cell in linear time', () => {
    expectLinearCost((n) => ` #${'\t'.repeat(n)}x`, escapeTableCell);
    expectLinearCost((n) => ` \n${' '.repeat(n)}x`, escapeTableCell);
  });
});

describe('escapeTableCell — Markdown in cell values', () => {
  it.each(HOSTILE)('renders %j as the literal text, in one cell', (value) => {
    const html = renderMarkdown(`| a | b |\n| --- | --- |\n| ${escapeTableCell(value)} | end |`);
    const cells = renderedCells(html);
    expect(cells.map(readBack)).toEqual([value.replace(/\s*[\r\n]+\s*/g, ' ').trim(), 'end']);
    expect(strayElements(cells[0] ?? '', [])).toEqual([]);
  });

  it('renders the issue repro cell with exactly the escapes it names', () => {
    expect(escapeTableCell('<b>literal</b> *emphasis* [label](https://example.com)')).toBe(
      '\\<b>literal\\</b> \\*emphasis\\* \\[label\\](https://example.com)',
    );
  });

  it.each(PLAIN)('leaves %j byte-identical', (value) => {
    expect(escapeTableCell(value)).toBe(value);
  });
});

describe('escapeMarkdownText', () => {
  describe('inline — inside a line of server-authored Markdown', () => {
    it.each(HOSTILE)('renders %j as the literal text', (value) => {
      const html = renderMarkdown(`**Label:** "${escapeMarkdownText(value)}" | after`);
      expect(readBack(html).trim()).toBe(`Label: "${flat(value)}" | after`);
      expect(strayElements(html, ['p', 'strong'])).toEqual([]);
    });

    it.each(PLAIN)('leaves %j byte-identical', (value) => {
      expect(escapeMarkdownText(value)).toBe(value);
    });

    it('escapes an underscore run unless letters or digits sit on both sides of it', () => {
      expect(escapeMarkdownText('a_b a__b _a b_ _ __init__')).toBe(
        'a_b a__b \\_a b\\_ \\_ \\_\\_init\\_\\_',
      );
    });

    it('escapes a backslash, so an escape it would have formed reads back literally', () => {
      expect(escapeMarkdownText('[x\\](javascript:alert(1))')).toBe(
        '\\[x\\\\\\](javascript:alert(1))',
      );
    });

    it('escapes `<` only where it opens a tag, comment, declaration, or autolink', () => {
      expect(escapeMarkdownText('<b> </b> <!-- <? <5 < 1 <1@a.co> <=')).toBe(
        '\\<b> \\</b> \\<!-- \\<? <5 < 1 \\<1@a.co> <=',
      );
    });

    it('escapes `&` only where it opens an entity reference', () => {
      expect(escapeMarkdownText('&amp; &#169; &#x41; AT&T & &;')).toBe(
        '\\&amp; \\&#169; \\&#x41; AT&T & &;',
      );
    });

    it('flattens CR, LF, and CRLF to one space each', () => {
      expect(escapeMarkdownText('a\r\nb\rc\nd')).toBe('a b c d');
    });
  });

  describe('bare URLs', () => {
    /** From the `p56q-jrxg` description: `-_` is not intraword, so a blind escape lands in the link. */
    const url = 'https://www.cdc.gov/nchs/nvss/bridged_race/county_geography-_changes2015.pdf';

    it.each(['inline', 'line', 'heading'] as const)(
      'links a bare URL to the address it spells (%s)',
      (slot) => {
        const prefix = slot === 'heading' ? '### ' : '';
        const html = renderMarkdown(
          `${prefix}${escapeMarkdownText(`Available from: ${url}.`, slot)}`,
        );
        expect(html).toContain(`href="${url}"`);
        expect(readBack(html).trim()).toBe(`Available from: ${url}.`);
      },
    );

    it('links a bare URL in a table cell to the address it spells', () => {
      const html = renderMarkdown(oneCellTable(escapeTableCell(`Available from: ${url}.`)));
      expect(html).toContain(`href="${url}"`);
      expect(renderedCells(html).map(readBack)).toEqual([`Available from: ${url}.`]);
    });

    it('keeps an escape that trails a URL from turning into emphasis', () => {
      const value = 'see https://x.org/a* and https://x.org/b*';
      const html = renderMarkdown(`**Label:** ${escapeMarkdownText(value)}`);
      expect(html).not.toContain('<em>');
      expect(html).toContain('href="https://x.org/a"');
      expect(html).toContain('href="https://x.org/b"');
      expect(readBack(html).trim()).toBe(`Label: ${value}`);
    });

    it('wraps only a URL whose autolink run holds something the escaper touches', () => {
      expect(escapeMarkdownText(`Available from: ${url}.`)).toBe(`Available from: <${url}>.`);
      expect(escapeMarkdownText('see https://x.org/a* and https://x.org/b*')).toBe(
        'see <https://x.org/a>\\* and <https://x.org/b>\\*',
      );
      expect(escapeMarkdownText('a https://x.org/b|c d')).toBe('a <https://x.org/b>\\|c d');
    });

    it('leaves every other URL bare and byte-identical', () => {
      for (const value of [
        'see https://www.cdc.gov/nchs/data_access/vitalstatsonline.htm for more',
        '(https://example.com/a(b)c)',
        'https://x.org/?a=1&b=2, then https://y.org/z.',
      ]) {
        expect(escapeMarkdownText(value)).toBe(value);
      }
      expect(escapeTableCell('[label](https://example.com)')).toBe(
        '\\[label\\](https://example.com)',
      );
    });
  });

  describe('line — opening a line of its own', () => {
    it.each(HOSTILE)('renders %j as the literal text, continuing the paragraph', (value) => {
      const html = renderMarkdown(`**ID:** x | **Type:** y\n${escapeMarkdownText(value, 'line')}`);
      expect(readBack(html).trim()).toBe(`ID: x | Type: y\n${flat(value).trimStart()}`.trim());
      expect(strayElements(html, ['p', 'strong'])).toEqual([]);
    });

    it.each(HOSTILE)('renders %j as the literal text at the start of a document', (value) => {
      const html = renderMarkdown(escapeMarkdownText(value, 'line'));
      expect(readBack(html).trim()).toBe(flat(value).trim());
      expect(strayElements(html, ['p'])).toEqual([]);
    });

    it('escapes an ordered-list marker and a heading marker', () => {
      expect(escapeMarkdownText('2000. year', 'line')).toBe('2000\\. year');
      expect(escapeMarkdownText('# title', 'line')).toBe('\\# title');
    });

    it('leaves a marker in the middle of the line alone', () => {
      expect(escapeMarkdownText('Since 2000. # of cases - total', 'line')).toBe(
        'Since 2000. # of cases - total',
      );
    });
  });

  describe('heading — the text of an ATX heading', () => {
    it.each(HOSTILE)('renders %j as the literal heading text', (value) => {
      const html = renderMarkdown(`### ${escapeMarkdownText(value, 'heading')}\nnext`);
      expect(html.startsWith('<h3>')).toBe(true);
      const heading = html.slice(4, html.indexOf('</h3>'));
      expect(readBack(heading)).toBe(flat(value).trim());
      expect(strayElements(heading, [])).toEqual([]);
    });

    it('keeps a trailing `#` run, which ATX would otherwise strip as a closing sequence', () => {
      expect(escapeMarkdownText('Cases by week #', 'heading')).toBe('Cases by week \\#');
      expect(escapeMarkdownText('Rank #1', 'heading')).toBe('Rank #1');
    });
  });
});

describe('strayElements', () => {
  it('reports an autolink whose target carries a backslash an escape left inside it', () => {
    const html = renderMarkdown('see https://x.org/a-\\_b and https://x.org/c');
    expect(strayElements(html, ['p'])).toEqual(['a']);
  });
});

describe('markdownCodeSpan', () => {
  it.each([
    'count(*)',
    '$select=state, count(*) as n&$where=year=2017&$having=count(*) > 5',
    'a`b',
    '``fenced``',
    '`leading',
    'trailing`',
    ' padded ',
    "where name='x' | y",
  ])('renders %j as one code span that reads back byte-identical', (value) => {
    const html = renderMarkdown(`**Query:** ${markdownCodeSpan(value)}`);
    const code = html.match(/<code>([\s\S]*)<\/code>/)?.[1];
    expect(code).toBeDefined();
    expect(readBack(code ?? '')).toBe(value);
    expect(strayElements(html, ['p', 'strong', 'code'])).toEqual([]);
  });

  it('flattens line endings, so a blank line in the value cannot end the span', () => {
    const value = 'year=2020\n\n# injected `';
    const html = renderMarkdown(`**Query:** ${markdownCodeSpan(value)}`);
    expect(html).not.toContain('<h1>');
    expect(readBack(html.match(/<code>([\s\S]*)<\/code>/)?.[1] ?? '')).toBe(flat(value));
  });
});

describe('markdownTableCodeSpan', () => {
  it('keeps a pipe inside the code span and the span inside its cell', () => {
    const html = renderMarkdown(
      `| a | b |\n| --- | --- |\n| ${markdownTableCodeSpan('x|y`z')} | end |`,
    );
    expect(renderedCells(html)).toEqual(['<code>x|y`z</code>', 'end']);
  });
});

describe('markdownBlockquote', () => {
  it('renders one blockquote whose every line reads back literally', () => {
    const text = 'No match for "a\n\n# injected\r\n- item\r> nested <b>x</b>". Try again.';
    const markdown = markdownBlockquote(text);
    for (const line of markdown.split('\n')) expect(line.startsWith('>')).toBe(true);

    const html = renderMarkdown(markdown);
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(strayElements(html, ['blockquote', 'p'])).toEqual([]);
    expect(readBack(html).replace(/\s+/g, ' ').trim()).toBe(
      'No match for "a # injected - item > nested <b>x</b>". Try again.',
    );
  });

  it('renders a single-line notice as one quoted line', () => {
    expect(markdownBlockquote('count(*) > 5 matched nothing.')).toBe(
      '> count(\\*) > 5 matched nothing.',
    );
  });
});

describe('escaper cost on worst-case input', () => {
  const shapes: Record<string, (n: number) => string> = {
    'repeated tag opener with no closer': (n) => '<a'.repeat(n / 2),
    'one opener before a long autolink-local run': (n) => `<${'1'.repeat(n - 1)}`,
    'openers each before a short local run': (n) => '<1'.repeat(n / 2),
    'one long underscore run': (n) => '_'.repeat(n),
    'alternating word and underscore': (n) => 'a_'.repeat(n / 2),
    'entity openers with no terminator': (n) => '&#1'.repeat(n / 3),
    'backslashes and brackets': (n) => '\\['.repeat(n / 2),
    'one URL holding a long escaped run': (n) => `https://x.org/${'-_'.repeat((n - 14) / 2)}`,
    'URLs back to back in one autolink run': (n) => 'https://x.org/a*'.repeat(n / 16),
    'URLs each with a trailing escape': (n) => 'https://x.org/a* '.repeat(n / 17),
    'one URL ending in a long trailing-punctuation run': (n) =>
      `https://x.org/${'&a;)'.repeat((n - 14) / 4)}`,
    'scheme openers with no host': (n) => 'https://'.repeat(n / 8),
  };

  it.each(Object.entries(shapes))('stays linear on %s', (_name, build) => {
    for (const slot of ['inline', 'line', 'heading'] as const) {
      expectLinearCost(build, (input) => escapeMarkdownText(input, slot));
    }
  });
});
