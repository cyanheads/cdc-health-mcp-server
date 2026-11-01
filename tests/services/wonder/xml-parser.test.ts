/**
 * @fileoverview Tests for the WONDER XML parser — `<data-table>` rows, `<message>` notices, and
 * the provisional database's data-through date.
 * @module tests/services/wonder/xml-parser
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDataTable, parseDataThrough, parseMessages } from '@/services/wonder/xml-parser.js';
import { expectLinearCost, expectLinearDoublings, fill } from '../../helpers/cpu-cost.js';

/** A recorded WONDER response under `tests/fixtures/wonder`, unchanged. */
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/wonder/${name}`, import.meta.url), 'utf8');

/** A real D158 response (race × age group, cause C00, 2024), captured from WONDER unchanged. */
const D158_RESPONSE = fixture('d158-race-age-c00-2024.response.xml');

/** One caveat element wrapping `inner` in CDATA, as WONDER sends them, parsed alone. */
function caveatOf(inner: string): string | undefined {
  const xml = `<results><caveats><caveat><![CDATA[${inner}]]></caveat></caveats></results>`;
  return parseDataTable(xml, ['year', 'deaths'], 1).caveats[0];
}

describe('links in caveats and messages', () => {
  it('keeps every link destination on a captured D158 response', () => {
    const { rows, caveats } = parseDataTable(
      D158_RESPONSE,
      ['race', 'age_group', 'deaths', 'population', 'crude_rate'],
      2,
    );
    expect(rows).toHaveLength(4);
    expect(caveats).toHaveLength(8);
    expect(caveats[0]).toBe(
      'Data are Suppressed when the data meet the criteria for confidentiality constraints. [More information.](https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Assurance%20of%20Confidentiality)',
    );
    expect(caveats[2]).toBe(
      'The method used to calculate 95% confidence intervals is documented here: [More information.](https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Confidence-Intervals)',
    );
    expect(caveats[7]).toBe(
      'Changes to cause of death classification affect reporting trends. [More information.](https://wonder.cdc.gov/wonder/help/ucd-expanded.html#ICD-10%20Changes)',
    );
    // Seven of the eight carry a link; the North Carolina revision note has none.
    const linked = caveats.filter((c) => /\]\(https:\/\/wonder\.cdc\.gov\/wonder\/help\//.test(c));
    expect(linked).toHaveLength(7);
    expect(caveats[6]).toMatch(
      /^After the creation of the final 2023 dataset.*mortality datasets\.$/,
    );
    for (const caveat of caveats) {
      expect(caveat).not.toMatch(/onclick|target=|setfocus|<a\b|WONDER_Help/);
    }
  });

  it('keeps the link on a captured message and leaves the hidden-row notices as they were', () => {
    expect(parseMessages(D158_RESPONSE)).toEqual([
      'Totals are not available for these results due to suppression constraints. [More Information.](https://wonder.cdc.gov/wonder/help/faq.html#Privacy)',
      'Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.',
      'Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.',
    ]);
  });

  it('converts several links in one caveat, each resolved on its own', () => {
    expect(
      caveatOf(
        'See <a href="/wonder/help/a.html#One">part one</a> and <a href="https://www.cdc.gov/nchs/b.htm">part two</a>, then <a href=\'c.html\'>three</a>.',
      ),
    ).toBe(
      'See [part one](https://wonder.cdc.gov/wonder/help/a.html#One) and [part two](https://www.cdc.gov/nchs/b.htm), then [three](https://wonder.cdc.gov/c.html).',
    );
  });

  it('keeps the text and drops the link for a fragment-only href', () => {
    /** A fragment on its own points into CDC's web page, which the caller never sees. */
    expect(
      caveatOf('Rates use <a href="#Non-standard Age Adjusted Rate">these parameters</a>.'),
    ).toBe('Rates use these parameters.');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['mailto:', 'mailto:wonder@cdc.gov'],
    ['data:', 'data:text/html,hi'],
    ['unparseable', 'http://[bad'],
  ])('keeps the text and drops the link for a %s href', (_label, href) => {
    expect(caveatOf(`Read <a href="${href}">the notes</a> first.`)).toBe('Read the notes first.');
  });

  it('keeps the text of an anchor that carries no href', () => {
    expect(caveatOf('See <a name="top">the top</a>.')).toBe('See the top.');
  });

  it('decodes an entity-bearing href exactly once', () => {
    expect(caveatOf('See <a href="/help?a=1&amp;b=2&amp;amp;c">the query</a>.')).toBe(
      'See [the query](https://wonder.cdc.gov/help?a=1&b=2&amp;c).',
    );
  });

  it('decodes entities once across text, link text, and CDATA', () => {
    expect(
      caveatOf(
        'Codes &amp;lt;b&amp;gt; &amp; <a href="/h.html"><b>Deaths</b> &amp; births &amp;lt;1</a> &#8212; done.',
      ),
    ).toBe('Codes &lt;b&gt; & [Deaths & births &lt;1](https://wonder.cdc.gov/h.html) — done.');
  });

  it('leaves an entity-encoded anchor as literal text rather than making it a link', () => {
    /** The publisher escaped the markup so it would be read as text, not followed. */
    expect(caveatOf('Write &lt;a href="/h.html"&gt;x&lt;/a&gt; to link.')).toBe(
      'Write <a href="/h.html">x</a> to link.',
    );
  });

  it('escapes brackets and parentheses so the link cannot be broken open', () => {
    expect(caveatOf('See <a href="/h (old).html#A b">notes [2024] \\ more</a>.')).toBe(
      'See [notes \\[2024\\] \\\\ more](https://wonder.cdc.gov/h%20%28old%29.html#A%20b).',
    );
  });

  it('drops an anchor whose text is empty', () => {
    expect(caveatOf('Icon <a href="/h.html"><img src="i.png"/></a> here.')).toBe('Icon here.');
  });

  it('leaves unlinked text exactly as the plain-text conversion renders it', () => {
    expect(caveatOf('Deaths &amp; births, <b>national</b>\n\t\ttotals.')).toBe(
      'Deaths & births, national totals.',
    );
  });

  it('leaves the text after an anchor that never closes as plain text', () => {
    expect(caveatOf('See <a href="/h.html">the notes and more.')).toBe('See the notes and more.');
    expect(
      caveatOf('Read <a href="/one.html">one</a> then <a href="/two.html">two, unclosed.'),
    ).toBe('Read [one](https://wonder.cdc.gov/one.html) then two, unclosed.');
    expect(caveatOf('Cut off at the end <a href="/h.html')).toBe('Cut off at the end');
  });

  it('pairs an opener with the first closer after it, as the tag grammar reads them', () => {
    /** Attributes run to the first `>`, so an opener inside them belongs to the anchor. */
    expect(caveatOf('<a <a href="/h.html">x</a> y')).toBe('[x](https://wonder.cdc.gov/h.html) y');
    expect(caveatOf('<A HREF="/h.html">x</A  > and <abbr>y</abbr>')).toBe(
      '[x](https://wonder.cdc.gov/h.html) and y',
    );
    expect(caveatOf('<a href="/one.html">one <a href="/two.html">two</a> three</a>')).toBe(
      '[one two](https://wonder.cdc.gov/one.html) three',
    );
  });

  it('converts a recorded D76 response’s caveat links as before', () => {
    /** The keep-working case: CDC's live methodology links, read off recorded responses. */
    const d76 = fixture('d76-x40-x44-by-year-2018-2019.response.xml');
    const { caveats } = parseDataTable(d76, ['year', 'deaths'], 1);
    expect(caveats).toHaveLength(6);
    expect(caveats[0]).toBe(
      'The populations used to calculate standard age-adjusted rates are documented here: [More information.](https://wonder.cdc.gov/wonder/help/ucd.html#2000%20Standard%20Population)',
    );
    expect(caveats[1]).toBe(
      'The method used to calculate age-adjusted rates is documented here: [More information.](https://wonder.cdc.gov/wonder/help/ucd.html#Age-Adjusted%20Rates)',
    );
    expect(caveats[2]).toBe(
      'Deaths for persons of unknown age are included in counts and crude rates, but are not included in age-adjusted rates.',
    );
    expect(caveats[5]).toBe(
      'Changes to cause of death classification affect reporting trends. [More information.](https://wonder.cdc.gov/wonder/help/ucd.html#ICD-10%20Changes)',
    );
  });

  describe('cost on worst-case markup', () => {
    /** Anchor markup of about `n` characters, every opener left unclosed. */
    const shapes: Record<string, (n: number) => string> = {
      'repeated anchor opener with no closer': (n) => '<a'.repeat(n / 2),
      'repeated complete opening tag with no closer': (n) => '<a href="/h.html">'.repeat(n / 18),
      'opening tags among partial closers': (n) => '<a></a '.repeat(n / 7),
      'one closed anchor, then unclosed openers': (n) => `<a>x</a>${'<a>'.repeat(n / 3)}`,
    };

    it.each(Object.entries(shapes))('stays linear on %s', (_name, build) => {
      expectLinearCost(build, (markup) =>
        parseMessages(`<page><message>${markup}</message></page>`),
      );
    });
  });

  it('links a message the same way it links a caveat', () => {
    const xml =
      '<page><message><![CDATA[Read <A HREF="/wonder/help/faq.html#Privacy">the FAQ</A>.]]></message></page>';
    expect(parseMessages(xml)).toEqual([
      'Read [the FAQ](https://wonder.cdc.gov/wonder/help/faq.html#Privacy).',
    ]);
  });
});

describe('parseMessages', () => {
  it('reads every message on a successful response, not just the first', () => {
    /** A rejection states its reason in the first message; a 200 stacks unrelated notices. */
    const xml = `<page>
      <message><![CDATA[Totals are not available for these results due to suppression constraints. <a href="/wonder/help/faq.html#Privacy">More Information.</a>]]></message>
      <message>Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.</message>
      <message>Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.</message>
    </page>`;
    expect(parseMessages(xml)).toEqual([
      'Totals are not available for these results due to suppression constraints. [More Information.](https://wonder.cdc.gov/wonder/help/faq.html#Privacy)',
      'Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.',
      'Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.',
    ]);
  });

  it('decodes entities and drops empty messages', () => {
    const xml = `<page><message>Ages 5&#39;14 &amp; up</message><message>  </message></page>`;
    expect(parseMessages(xml)).toEqual(["Ages 5'14 & up"]);
  });

  it('returns nothing when the response carries no messages', () => {
    expect(parseMessages('<page><data-table></data-table></page>')).toEqual([]);
  });

  it('decodes an escaped entity once, leaving pre-escaped markup as text', () => {
    /**
     * A chained decode resolves `&amp;` before `&lt;`/`&gt;`, so `&amp;lt;b&amp;gt;` came out
     * as `<b>` — markup manufactured from text a publisher had escaped precisely so it would
     * not be markup.
     */
    const xml = '<page><message>Codes written &amp;lt;b&amp;gt; are excluded.</message></page>';
    expect(parseMessages(xml)).toEqual(['Codes written &lt;b&gt; are excluded.']);
  });

  it('leaves an out-of-range numeric reference as text instead of throwing', () => {
    /** `String.fromCodePoint` raises a RangeError above U+10FFFF. */
    const xml = '<page><message>Marker &#x110000; retained.</message></page>';
    expect(parseMessages(xml)).toEqual(['Marker &#x110000; retained.']);
  });

  it('never emits a lone-surrogate reference as a raw code point', () => {
    /**
     * Bun round-trips a lone surrogate through JSON.stringify/parse without complaint, but a
     * strict consumer (jq) rejects the whole frame as an invalid surrogate pair escape — so
     * the reference stays literal text rather than becoming an unpaired code unit.
     */
    const xml = '<page><message>Marker &#xD800; retained.</message></page>';
    const [message] = parseMessages(xml);
    expect(message).toBe('Marker &#xD800; retained.');
    for (const char of message ?? '') {
      const code = char.charCodeAt(0);
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it('decodes a well-formed numeric reference', () => {
    const xml = '<page><message>Rate per 100&#37; &#8212; see notes.</message></page>';
    expect(parseMessages(xml)).toEqual(['Rate per 100% — see notes.']);
  });
});

describe('parseDataThrough', () => {
  const dataset = (vintage: string) =>
    `<page><dataset code="D176" label="Provisional" vintage="${vintage}" totals="true">
      <variable code="D176.V1"/></dataset><data-table></data-table></page>`;

  it.each([
    'd176-2025-2026-partial-year.response.xml',
    'd176-overdose-2025-2026-lag.response.xml',
    'd176-withheld-cause-all-years.response.xml',
  ])('reads the data-through date off the captured provisional response %s', (name) => {
    // `vintage="October 17, 2026 as of  October 25, 2026"` — the first date is the data-through one.
    expect(parseDataThrough(fixture(name))).toBe('2026-10-17');
  });

  it.each([
    'd76-x40-x44-by-year-2018-2019.response.xml',
    'd158-race-age-c00-2024.response.xml',
    'd77-2019-intervals.response.xml',
  ])('reads no date off the final-database response %s, whose vintage is a bare year', (name) => {
    expect(parseDataThrough(fixture(name))).toBeUndefined();
  });

  it.each([
    ['January 3, 2027 as of January 11, 2027', '2027-01-03'],
    ['february 29, 2028', '2028-02-29'],
    ['  May 2,2026 as of May 10, 2026', '2026-05-02'],
  ])('reads %j as %s', (vintage, iso) => {
    expect(parseDataThrough(dataset(vintage))).toBe(iso);
  });

  it.each([
    ['a bare year', '2024'],
    ['a date that does not exist', 'February 30, 2026'],
    ['a month CDC does not write', 'Octember 17, 2026'],
    ['no year', 'October 17 as of October 25'],
    ['a date after other text', 'as of October 25, 2026'],
    ['an empty vintage', ''],
  ])('reads no date from %s', (_label, vintage) => {
    expect(parseDataThrough(dataset(vintage))).toBeUndefined();
  });

  it('reads no date when the response has no dataset element, or only a lookalike', () => {
    expect(parseDataThrough('<page><data-table></data-table></page>')).toBeUndefined();
    expect(parseDataThrough('<datasets vintage="October 17, 2026">')).toBeUndefined();
    expect(parseDataThrough('<dataset vintage="October 17, 2026"')).toBeUndefined();
  });

  /** Timing: the vintage is upstream text, so reading it stays linear however CDC sizes it. */
  describe('timing', () => {
    const REPEATS = 200;
    const expectLinear = (build: (n: number) => string, largest: number) =>
      expectLinearDoublings(build, largest, parseDataThrough, REPEATS);

    it.each([
      ['dataset openers with no >', (n: number) => fill('<dataset ', n)],
      ['lookalike openers before the real one', (n: number) => `${fill('<datasets ', n)}<dataset>`],
      [
        'vintage attributes with no closing quote',
        (n: number) => `<dataset${fill(' vintage="x', n)}>`,
      ],
      ['a vintage of one long word', (n: number) => `<dataset vintage="${fill('October', n)}">`],
      [
        'a vintage of month names and spaces',
        (n: number) => `<dataset vintage="${fill('May ', n)}">`,
      ],
      [
        'one long line ending in a break',
        (n: number) => `<dataset vintage="${fill('§1 x', n)}\ny">`,
      ],
      ['line breaks throughout', (n: number) => `<dataset vintage="${fill('  \r\n', n)}">`],
    ])('stays linear on %s', (_label, build) => {
      expectLinear(build, 80_000);
    });

    it('stays linear across the full 64× span on a long digit run', () => {
      expectLinear((n) => `<dataset vintage="May ${'1'.repeat(n)}, 2026">`, 320_000);
    });
  });
});

describe('parseDataTable', () => {
  it('parses a single-dimension table and strips comma thousands separators', () => {
    const xml = `<data-table>
      <r><c l="1999"/><c v="2,391,399"/><c v="279,040,168"/><c v="857.0"/></r>
      <r><c l="2000"/><c v="2,403,351"/><c v="281,421,906"/><c v="854.0"/></r>
    </data-table>`;
    const { rows, suppressedCount } = parseDataTable(
      xml,
      ['year', 'deaths', 'population', 'crude_rate'],
      1,
    );
    expect(suppressedCount).toBe(0);
    const noInterval = { crude_rate_lower: null, crude_rate_upper: null };
    expect(rows).toEqual([
      { year: '1999', deaths: 2391399, population: 279040168, crude_rate: 857, ...noInterval },
      { year: '2000', deaths: 2403351, population: 281421906, crude_rate: 854, ...noInterval },
    ]);
  });

  it('reconstructs rowspanned outer dimensions across grouped rows', () => {
    // Year cell carries r="2" and is omitted on the second row of each group.
    const xml = `<data-table>
      <r><c l="1999" r="2"/><c l="Female"/><c v="1,000"/></r>
      <r><c l="Male"/><c v="2,000"/></r>
      <r><c l="2000" r="2"/><c l="Female"/><c v="1,100"/></r>
      <r><c l="Male"/><c v="2,100"/></r>
    </data-table>`;
    const { rows } = parseDataTable(xml, ['year', 'sex', 'deaths'], 2);
    expect(rows).toEqual([
      { year: '1999', sex: 'Female', deaths: 1000 },
      { year: '1999', sex: 'Male', deaths: 2000 },
      { year: '2000', sex: 'Female', deaths: 1100 },
      { year: '2000', sex: 'Male', deaths: 2100 },
    ]);
  });

  it('maps suppressed cells to null and counts them; decodes entity-escaped labels', () => {
    const xml = `<data-table>
      <r><c l="&lt; 1 year"/><c v="Suppressed"/></r>
      <r><c l="1-4"/><c v="5,432"/></r>
    </data-table>`;
    const { rows, cellNotes, suppressedCount } = parseDataTable(xml, ['age_group', 'deaths'], 1);
    expect(suppressedCount).toBe(1);
    expect(cellNotes).toEqual([{ row: 0, column: 'deaths', token: 'Suppressed' }]);
    expect(rows).toEqual([
      { age_group: '< 1 year', deaths: null },
      { age_group: '1-4', deaths: 5432 },
    ]);
  });

  it('trims a padded dimension label so it keys the same as the bare one beside it', () => {
    /**
     * D158 and D157 render their last year as `2024 `; D176's own 2024 and every other year
     * come back bare. Untrimmed, `"2024 " !== "2024"` splits one year across two databases.
     */
    const padded = `<data-table><r><c l="2024 "/><c v="3,090,964"/></r></data-table>`;
    const bare = `<data-table><r><c l="2024"/><c v="3,071,269"/></r></data-table>`;
    const from = (xml: string) => parseDataTable(xml, ['year', 'deaths'], 1).rows[0]?.year;
    expect(from(padded)).toBe('2024');
    expect(from(padded)).toBe(from(bare));
  });

  it('trims entity-encoded padding without touching the inside of a composite label', () => {
    // `2025 (provisional)` is CDC's own label — the interior space is part of it.
    const xml = `<data-table>
      <r><c l="&nbsp;2025 (provisional)&nbsp;"/><c v="10"/></r>
      <r><c l=" 85+ years "/><c v="20"/></r>
    </data-table>`;
    const { rows } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(rows.map((r) => r.year)).toEqual(['2025 (provisional)', '85+ years']);
  });

  it('trims a padded label carried forward across a rowspan group', () => {
    const xml = `<data-table>
      <r><c l="2024 " r="2"/><c l="Female"/><c v="1,000"/></r>
      <r><c l="Male"/><c v="2,000"/></r>
    </data-table>`;
    const { rows } = parseDataTable(xml, ['year', 'sex', 'deaths'], 2);
    expect(rows.map((r) => r.year)).toEqual(['2024', '2024']);
  });

  it('renders an empty measure cell as null with no cell note', () => {
    const xml = `<data-table><r><c l="2020"/><c v=""/></r></data-table>`;
    const { rows, cellNotes, suppressedCount } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(rows).toEqual([{ year: '2020', deaths: null }]);
    expect(cellNotes).toEqual([]);
    expect(suppressedCount).toBe(0);
  });

  it('records a non-suppression status token per cell instead of collapsing it to a bare null', () => {
    // "Unreliable" (a rate CDC judged unstable) and "Not Applicable" (no denominator) replace
    // the value for a reason other than confidentiality — they must not read as suppression.
    const xml = `<data-table>
      <r><c l="15-24 years"/><c v="10"/><c v="42,687,510"/><c v="Unreliable"/></r>
      <r><c l="25-34 years"/><c v="8"/><c v="1,000"/><c v="Not Applicable"/></r>
      <r><c l="35-44 years"/><c v="12"/><c v="2,000"/><c v="0.6"/></r>
    </data-table>`;
    const { rows, cellNotes, suppressedCount } = parseDataTable(
      xml,
      ['age_group', 'deaths', 'population', 'crude_rate'],
      1,
    );
    expect(suppressedCount).toBe(0);
    expect(cellNotes).toEqual([
      { row: 0, column: 'crude_rate', token: 'Unreliable' },
      { row: 1, column: 'crude_rate', token: 'Not Applicable' },
    ]);
    expect(rows[0]).toEqual({
      age_group: '15-24 years',
      deaths: 10,
      population: 42687510,
      crude_rate: null,
      crude_rate_lower: null,
      crude_rate_upper: null,
    });
    expect(rows[2]).toMatchObject({ crude_rate: 0.6 });
  });

  it('records an unrecognized non-numeric token rather than silently nulling the cell', () => {
    const xml = `<data-table><r><c l="2020"/><c v="Not Available"/></r></data-table>`;
    const { rows, cellNotes, suppressedCount } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(rows).toEqual([{ year: '2020', deaths: null }]);
    expect(cellNotes).toEqual([{ row: 0, column: 'deaths', token: 'Not Available' }]);
    expect(suppressedCount).toBe(0);
  });

  it('skips subtotal/total rows carrying dt or leading c= markers', () => {
    const xml = `<data-table>
      <r><c l="1999" r="2"/><c l="Female"/><c v="1,000"/></r>
      <r><c l="Male"/><c v="2,000"/></r>
      <r><c c="1"/><c dt="3,000"/></r>
    </data-table>`;
    const { rows } = parseDataTable(xml, ['year', 'sex', 'deaths'], 2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sex === 'Female' || r.sex === 'Male')).toBe(true);
  });

  it('extracts caveats and footnotes with CDATA and HTML stripped, keeping link destinations', () => {
    const xml = `<results>
      <data-table><r><c l="1999"/><c v="10"/></r></data-table>
      <caveats><caveat><![CDATA[Population figures <b>are</b> <a href="x">documented here</a>.]]></caveat></caveats>
      <footnotes><footnote>Suppressed when fewer than ten deaths.</footnote></footnotes>
    </results>`;
    const { caveats } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(caveats).toEqual([
      'Population figures are [documented here](https://wonder.cdc.gov/x).',
      'Suppressed when fewer than ten deaths.',
    ]);
  });

  it('drops unresolved wonder: template expressions from caveats, keeping real prose', () => {
    const xml = `<results>
      <data-table><r><c l="1999"/><c v="10"/></r></data-table>
      <caveats>
        <caveat>wonder:mort-rankable-footnote()</caveat>
        <caveat>wonder:cmf-3('footnote')</caveat>
        <caveat>wonder:mort-ak-2014-in('footnote')</caveat>
        <caveat>Deaths are classified by ICD-10.</caveat>
        <caveat>See the CDC WONDER online database at wonder.cdc.gov for details.</caveat>
      </caveats>
    </results>`;
    const { caveats } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(caveats).toEqual([
      'Deaths are classified by ICD-10.',
      'See the CDC WONDER online database at wonder.cdc.gov for details.',
    ]);
  });

  it('returns no rows but still surfaces caveats when the table is absent', () => {
    const xml = `<results><caveats><caveat>Only a caveat.</caveat></caveats></results>`;
    const { rows, caveats } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(rows).toEqual([]);
    expect(caveats).toEqual(['Only a caveat.']);
  });

  describe('cause, origin and month groupings on captured responses', () => {
    const MEASURES = ['deaths', 'population', 'crude_rate', 'age_adjusted_rate'];
    const parse = (name: string, dimensions: string[]) =>
      parseDataTable(fixture(name), [...dimensions, ...MEASURES], dimensions.length);
    const MEASURE_KEYS = [
      'deaths',
      'population',
      'crude_rate',
      'crude_rate_lower',
      'crude_rate_upper',
      'age_adjusted_rate',
      'age_adjusted_rate_lower',
      'age_adjusted_rate_upper',
    ];
    /** The 20 chapters D76's request form lists in its ICD-10 finder, in its order. */
    const D76_CHAPTERS = [
      'A00-B99',
      'C00-D48',
      'D50-D89',
      'E00-E88',
      'F01-F99',
      'G00-G98',
      'H00-H57',
      'H60-H93',
      'I00-I99',
      'J00-J98',
      'K00-K92',
      'L00-L98',
      'M00-M99',
      'N00-N98',
      'O00-O99',
      'P00-P96',
      'Q00-Q99',
      'R00-R99',
      'U00-U99',
      'V01-Y89',
    ];

    it('reads each ICD chapter’s cd into cause_code, after the dimension and before the measures', () => {
      const { rows } = parse('d76-icd-chapter-2019.response.xml', ['icd_chapter']);
      expect(rows.map((row) => row.cause_code)).toEqual(D76_CHAPTERS);
      expect(Object.keys(rows[0] ?? {})).toEqual(['icd_chapter', 'cause_code', ...MEASURE_KEYS]);
      expect(rows[1]).toEqual({
        icd_chapter: 'Neoplasms',
        cause_code: 'C00-D48',
        deaths: 615191,
        population: 328239523,
        crude_rate: 187.4,
        crude_rate_lower: 187,
        crude_rate_upper: 187.9,
        age_adjusted_rate: 150,
        age_adjusted_rate_lower: 149.6,
        age_adjusted_rate_upper: 150.4,
      });
    });

    it('keeps the provisional withheld-cause row’s code in each of its two spellings', () => {
      // By chapter CDC writes the marker cause_icd10 takes; by sub-chapter, with one dash.
      const chapters = parse('d176-icd-chapter-2026-lag.response.xml', ['icd_chapter']).rows;
      expect(chapters).toHaveLength(21);
      expect(chapters.at(-1)).toMatchObject({
        icd_chapter:
          'Data not shown due to 6 month lag to account for delays in death certificate completion for certain causes of death.',
        cause_code: '999--999',
        deaths: 96700,
      });
      const subchapters = parse('d176-icd-subchapter-all-years.response.xml', [
        'icd_subchapter',
      ]).rows;
      expect(subchapters).toHaveLength(176);
      expect(subchapters.every((row) => typeof row.cause_code === 'string')).toBe(true);
      expect(subchapters[0]).toMatchObject({
        icd_subchapter: 'Intestinal infectious diseases',
        cause_code: 'A00-A09',
      });
      expect(subchapters.at(-1)?.cause_code).toBe('999-999');
    });

    it('keeps the sub-chapter’s code when chapter and sub-chapter are grouped together', () => {
      const { rows } = parse('d76-icd-chapter-and-subchapter.response.xml', [
        'icd_chapter',
        'icd_subchapter',
      ]);
      expect(rows).toHaveLength(177);
      expect(Object.keys(rows[0] ?? {})).toEqual([
        'icd_chapter',
        'icd_subchapter',
        'cause_code',
        ...MEASURE_KEYS,
      ]);
      expect(rows[0]).toMatchObject({
        icd_chapter: 'Certain infectious and parasitic diseases',
        icd_subchapter: 'Intestinal infectious diseases',
        cause_code: 'A00-A09',
        deaths: 154768,
      });
      expect(rows.filter((row) => D76_CHAPTERS.includes(String(row.cause_code)))).toEqual([]);
    });

    it('prefers the sub-chapter’s code whichever order the two are grouped in', () => {
      const xml = `<data-table>
        <r><c l="Intestinal infectious diseases" cd="A00-A09" cf="t"/><c l="Certain infectious and parasitic diseases" cd="A00-B99" cf="t"/><c v="154,768"/></r>
      </data-table>`;
      const { rows } = parseDataTable(xml, ['icd_subchapter', 'icd_chapter', 'deaths'], 2);
      expect(rows).toEqual([
        {
          icd_subchapter: 'Intestinal infectious diseases',
          icd_chapter: 'Certain infectious and parasitic diseases',
          cause_code: 'A00-A09',
          deaths: 154768,
        },
      ]);
    });

    it('reads each 113-cause row’s depth in the list into cause_level, as an integer', () => {
      const { rows } = parse('d77-cause-113-2019.response.xml', ['cause_113']);
      expect(rows).toHaveLength(131);
      expect(Object.keys(rows[0] ?? {})).toEqual(['cause_113', 'cause_level', ...MEASURE_KEYS]);
      const perLevel = Object.groupBy(rows, (row) => String(row.cause_level));
      expect(Object.fromEntries(Object.entries(perLevel).map(([k, v]) => [k, v?.length]))).toEqual({
        1: 49,
        2: 52,
        3: 21,
        4: 7,
        5: 2,
      });
      const level = (label: string) => rows.find((row) => row.cause_113 === label)?.cause_level;
      expect(level('#Tuberculosis (A16-A19)')).toBe(1);
      expect(level('Respiratory tuberculosis (A16)')).toBe(2);
      expect(level('Atherosclerotic cardiovascular disease, so described (I25.0)')).toBe(5);
    });

    it.each([
      ['d158-leading-causes-2023.response.xml', 'leading_causes', 15],
      ['d157-injury-intent-2023.response.xml', 'injury_intent', 6],
      ['d176-hispanic-origin-2025.response.xml', 'hispanic_origin', 3],
      ['d176-month-2026.response.xml', 'month', 10],
    ])('adds no code key to %s, whose cells carry none', (name, dimension, count) => {
      const { rows } = parse(name, [dimension]);
      expect(rows).toHaveLength(count);
      expect(Object.keys(rows[0] ?? {})).toEqual([dimension, ...MEASURE_KEYS]);
    });

    it('reads the leading causes in CDC’s order and trims a padded intent label', () => {
      const leading = parse('d158-leading-causes-2023.response.xml', ['leading_causes']).rows;
      expect(leading[0]).toMatchObject({
        leading_causes: '#Diseases of heart (I00-I09,I11,I13,I20-I51)',
        deaths: 680981,
        population: 334914895,
        crude_rate: 203.3,
        age_adjusted_rate: 162.1,
      });
      const intents = parse('d157-injury-intent-2023.response.xml', ['injury_intent']).rows;
      // CDC sends `Undetermined ` with a trailing space.
      expect(intents.map((row) => row.injury_intent)).toEqual([
        'Unintentional',
        'Suicide',
        'Homicide',
        'Undetermined',
        'Legal Intervention / Operations of War',
        'Non-Injury, no intent classified',
      ]);
    });

    it('nulls the population and rates CDC marks Not Applicable, by origin and by month', () => {
      const origin = parse('d176-hispanic-origin-2025.response.xml', ['hispanic_origin']);
      expect(origin.rows[0]).toMatchObject({
        hispanic_origin: 'Hispanic or Latino',
        population: 68086153,
      });
      expect(origin.rows[2]).toMatchObject({
        hispanic_origin: 'Not Stated',
        deaths: 12791,
        population: null,
        crude_rate: null,
        age_adjusted_rate: null,
      });
      expect(origin.cellNotes).toEqual(
        ['population', 'crude_rate', 'age_adjusted_rate'].map((column) => ({
          row: 2,
          column,
          token: 'Not Applicable',
        })),
      );

      const months = parse('d76-year-month-2019.response.xml', ['year', 'month']);
      expect(months.rows.map((row) => row.month)).toEqual(
        [
          'Jan.',
          'Feb.',
          'Mar.',
          'Apr.',
          'May',
          'Jun.',
          'Jul.',
          'Aug.',
          'Sep.',
          'Oct.',
          'Nov.',
          'Dec.',
        ].map((m) => `${m}, 2019`),
      );
      // The year cell spans all twelve months and is sent once.
      expect(months.rows.every((row) => row.year === '2019')).toBe(true);
      expect(months.rows[0]).toMatchObject({ deaths: 257649, population: null, crude_rate: null });
      expect(months.cellNotes).toHaveLength(36);
      expect(months.cellNotes.every((note) => note.token === 'Not Applicable')).toBe(true);
    });

    it('keeps the provisional month labels whole', () => {
      const { rows } = parse('d176-month-2026.response.xml', ['month']);
      expect(rows[0]?.month).toBe('Jan., 2026 (provisional)');
      expect(rows.at(-1)?.month).toBe('Oct., 2026 (provisional and partial)');
    });

    it('carries a code forward with its label through rowspans two levels deep', () => {
      const xml = `<data-table>
        <r><c l="Neoplasms" cd="C00-D48" cf="t" r="4"/><c l="2019" r="2"/><c l="Female"/><c v="1"/></r>
        <r><c l="Male"/><c v="2"/></r>
        <r><c l="2020" r="2"/><c l="Female"/><c v="3"/></r>
        <r><c l="Male"/><c v="4"/></r>
        <r><c l="External causes of morbidity and mortality" cd="V01-Y89" cf="t" r="2"/><c l="2019" r="2"/><c l="Female"/><c v="5"/></r>
        <r><c l="Male"/><c v="6"/></r>
      </data-table>`;
      const { rows } = parseDataTable(xml, ['icd_chapter', 'year', 'sex', 'deaths'], 3);
      expect(rows.map((row) => [row.cause_code, row.year, row.sex, row.deaths])).toEqual([
        ['C00-D48', '2019', 'Female', 1],
        ['C00-D48', '2019', 'Male', 2],
        ['C00-D48', '2020', 'Female', 3],
        ['C00-D48', '2020', 'Male', 4],
        ['V01-Y89', '2019', 'Female', 5],
        ['V01-Y89', '2019', 'Male', 6],
      ]);
      expect(rows.every((row) => Object.keys(row).indexOf('cause_code') === 3)).toBe(true);
    });

    it('reads each row’s own level when the 113-cause list sits inside a rowspanned year', () => {
      const xml = `<data-table>
        <r><c l="2019" r="3"/><c l="#Tuberculosis (A16-A19)" h="1"/><c v="526"/></r>
        <r><c l="Respiratory tuberculosis (A16)" h="2"/><c v="346"/></r>
        <r><c l="Other tuberculosis (A17-A19)" h="2"/><c v="180"/></r>
        <r><c l="2020" r="1"/><c l="#Tuberculosis (A16-A19)" h="1"/><c v="600"/></r>
      </data-table>`;
      const { rows } = parseDataTable(xml, ['year', 'cause_113', 'deaths'], 2);
      expect(rows.map((row) => [row.year, row.cause_level, row.deaths])).toEqual([
        ['2019', 1, 526],
        ['2019', 2, 346],
        ['2019', 2, 180],
        ['2020', 1, 600],
      ]);
    });

    it('reads a missing or malformed code as null rather than guessing one', () => {
      const xml = `<data-table>
        <r><c l="Neoplasms"/><c l="#Tuberculosis (A16-A19)" h="2a"/><c v="1"/></r>
        <r><c l="Neoplasms" cd="  C00-D48 "/><c l="Respiratory tuberculosis (A16)" h=""/><c v="2"/></r>
      </data-table>`;
      const { rows } = parseDataTable(xml, ['icd_chapter', 'cause_113', 'deaths'], 2);
      expect(rows).toEqual([
        {
          icd_chapter: 'Neoplasms',
          cause_113: '#Tuberculosis (A16-A19)',
          cause_code: null,
          cause_level: null,
          deaths: 1,
        },
        {
          icd_chapter: 'Neoplasms',
          cause_113: 'Respiratory tuberculosis (A16)',
          cause_code: 'C00-D48',
          cause_level: null,
          deaths: 2,
        },
      ]);
    });

    it('reads no code from a grouping that carries none, even when a cell has the attribute', () => {
      const xml = `<data-table><r><c l="2019" cd="A00-B99" h="1"/><c v="1"/></r></data-table>`;
      expect(parseDataTable(xml, ['year', 'deaths'], 1).rows).toEqual([
        { year: '2019', deaths: 1 },
      ]);
    });
  });

  describe('95% confidence intervals', () => {
    const RATES = ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'];
    const NULL_BOUNDS = {
      crude_rate_lower: null,
      crude_rate_upper: null,
      age_adjusted_rate_lower: null,
      age_adjusted_rate_upper: null,
    };

    it('puts each rate’s interval right after it, thousands separators stripped', () => {
      const xml = `<data-table>
        <r><c l="2026"/><c v="6,512"/><c v="628,400"/><c v="1,036.3" a="c"><l v="(1,035.1 - 1,037.5)"/></c><c v="725.8" a="c"><l v="(725.0 - 726.6)"/></c></r>
      </data-table>`;
      const { rows, cellNotes } = parseDataTable(xml, RATES, 1);
      expect(rows).toEqual([
        {
          year: '2026',
          deaths: 6512,
          population: 628400,
          crude_rate: 1036.3,
          crude_rate_lower: 1035.1,
          crude_rate_upper: 1037.5,
          age_adjusted_rate: 725.8,
          age_adjusted_rate_lower: 725,
          age_adjusted_rate_upper: 726.6,
        },
      ]);
      expect(Object.keys(rows[0]!)).toEqual([
        'year',
        'deaths',
        'population',
        'crude_rate',
        'crude_rate_lower',
        'crude_rate_upper',
        'age_adjusted_rate',
        'age_adjusted_rate_lower',
        'age_adjusted_rate_upper',
      ]);
      expect(cellNotes).toEqual([]);
    });

    it('keeps the interval CDC publishes with an Unreliable rate', () => {
      const xml = `<data-table>
        <r><c l="&lt; 1 year"/><c v="12"/><c v="3,795,762"/><c v="Unreliable" a="c"><l v="(0.2 - 0.6)"/></c></r>
      </data-table>`;
      const { rows, cellNotes } = parseDataTable(
        xml,
        ['age_group', 'deaths', 'population', 'crude_rate'],
        1,
      );
      expect(rows).toEqual([
        {
          age_group: '< 1 year',
          deaths: 12,
          population: 3795762,
          crude_rate: null,
          crude_rate_lower: 0.2,
          crude_rate_upper: 0.6,
        },
      ]);
      expect(cellNotes).toEqual([{ row: 0, column: 'crude_rate', token: 'Unreliable' }]);
    });

    it('leaves the bounds null on a Not Applicable cell CDC sent without an interval', () => {
      const xml = `<data-table>
        <r><c l="Not Stated"/><c v="10"/><c v="Not Applicable"/><c v="Not Applicable" a="c"></c></r>
      </data-table>`;
      const { rows, cellNotes } = parseDataTable(
        xml,
        ['age_group', 'deaths', 'population', 'crude_rate'],
        1,
      );
      expect(rows).toEqual([
        {
          age_group: 'Not Stated',
          deaths: 10,
          population: null,
          crude_rate: null,
          crude_rate_lower: null,
          crude_rate_upper: null,
        },
      ]);
      expect(cellNotes).toEqual([
        { row: 0, column: 'population', token: 'Not Applicable' },
        { row: 0, column: 'crude_rate', token: 'Not Applicable' },
      ]);
    });

    it('gives every row of a rate column its bound keys, null where CDC sent no interval', () => {
      /** `format()` takes its columns from the first row, so a later row may not add or drop one. */
      const xml = `<data-table>
        <r><c l="2019"/><c v="1"/><c v="2"/><c v="3.0"/><c v="4.0"/></r>
        <r><c l="2020"/><c v="1"/><c v="2"/><c v="3.0" a="c"><l v="(2.9 - 3.1)"/></c><c v="4.0" a="c"><l v="(3.9 - 4.1)"/></c></r>
      </data-table>`;
      const { rows } = parseDataTable(xml, RATES, 1);
      expect(rows[0]).toEqual({
        year: '2019',
        deaths: 1,
        population: 2,
        crude_rate: 3,
        age_adjusted_rate: 4,
        ...NULL_BOUNDS,
      });
      expect(Object.keys(rows[1]!)).toEqual(Object.keys(rows[0]!));
      expect(rows[1]).toMatchObject({ crude_rate_lower: 2.9, age_adjusted_rate_upper: 4.1 });
    });

    it('adds bound keys only beside the rates the table carries', () => {
      /** A table without the age-adjusted rate carries no age-adjusted bounds, and counts none. */
      const xml = `<data-table>
        <r><c l="25-34 years"/><c v="20,097" a="c"><l v="(1 - 2)"/></c><c v="45,542,516"/><c v="44.1" a="c"><l v="(43.5 - 44.7)"/></c></r>
      </data-table>`;
      const { rows } = parseDataTable(xml, ['age_group', 'deaths', 'population', 'crude_rate'], 1);
      expect(Object.keys(rows[0]!)).toEqual([
        'age_group',
        'deaths',
        'population',
        'crude_rate',
        'crude_rate_lower',
        'crude_rate_upper',
      ]);
    });

    it.each([
      ['no parentheses', '0.2 - 0.6'],
      ['one figure', '(0.2)'],
      ['three figures', '(0.2 - 0.6 - 0.9)'],
      ['a word for a figure', '(abc - 0.6)'],
      ['an empty side', '( - 0.6)'],
      ['nothing inside', '()'],
      ['an empty value', ''],
    ])('leaves both bounds null for an interval with %s', (_label, interval) => {
      const xml = `<data-table><r><c l="2019"/><c v="3.0" a="c"><l v="${interval}"/></c></r></data-table>`;
      const { rows, cellNotes } = parseDataTable(xml, ['year', 'crude_rate'], 1);
      expect(rows).toEqual([
        { year: '2019', crude_rate: 3, crude_rate_lower: null, crude_rate_upper: null },
      ]);
      expect(cellNotes).toEqual([]);
    });

    it('reads an interval set off by whitespace, and only the child that opens the cell', () => {
      const read = (cell: string) =>
        parseDataTable(
          `<data-table><r><c l="2019"/>${cell}</r></data-table>`,
          ['year', 'crude_rate'],
          1,
        ).rows[0];
      expect(read('<c v="3.0" a="c">\n  <l v="(2.9 - 3.1)" />\n</c>')).toMatchObject({
        crude_rate_lower: 2.9,
        crude_rate_upper: 3.1,
      });
      for (const cell of [
        '<c v="3.0" a="c">x<l v="(2.9 - 3.1)"/></c>',
        '<c v="3.0" a="c"><lx v="(2.9 - 3.1)"/></c>',
        '<c v="3.0"/><l v="(2.9 - 3.1)"/>',
      ]) {
        expect(read(cell)).toMatchObject({ crude_rate_lower: null, crude_rate_upper: null });
      }
    });

    it('reads both intervals off a captured D77 response that asked for them', () => {
      const body = fixture('d77-2019-intervals.response.xml');
      const { rows, cellNotes } = parseDataTable(body, RATES, 1);
      expect(rows).toEqual([
        {
          year: '2019',
          deaths: 2854838,
          population: 328239523,
          crude_rate: 869.7,
          crude_rate_lower: 868.7,
          crude_rate_upper: 870.8,
          age_adjusted_rate: 715.2,
          age_adjusted_rate_lower: 714.4,
          age_adjusted_rate_upper: 716.1,
        },
      ]);
      expect(cellNotes).toEqual([]);
    });

    it('reads a captured D76 table where an Unreliable rate has an interval and Not Applicable none', () => {
      const body = fixture('d76-x40-x49-year-age-1999-2001-intervals.response.xml');
      const { rows, cellNotes } = parseDataTable(
        body,
        ['year', 'age_group', 'deaths', 'population', 'crude_rate'],
        2,
      );
      expect(rows).toHaveLength(35);
      expect(rows[0]).toEqual({
        year: '1999',
        age_group: '< 1 year',
        deaths: 12,
        population: 3795762,
        crude_rate: null,
        crude_rate_lower: 0.2,
        crude_rate_upper: 0.6,
      });
      expect(rows[11]).toEqual({
        year: '1999',
        age_group: 'Not Stated',
        deaths: 12,
        population: null,
        crude_rate: null,
        crude_rate_lower: null,
        crude_rate_upper: null,
      });
      expect(rows[34]).toMatchObject({ year: '2001', age_group: 'Not Stated' });
      expect(rows[33]).toMatchObject({
        year: '2001',
        age_group: '85+ years',
        crude_rate: 3.5,
        crude_rate_lower: 3,
        crude_rate_upper: 4.1,
      });
      expect(cellNotes.filter((n) => n.token === 'Unreliable')).toHaveLength(3);
      for (const row of rows) expect(Object.keys(row)).toEqual(Object.keys(rows[0]!));
    });
  });
});

describe('element scans', () => {
  /**
   * Every recorded response's whole parse — rows, caveats, cell notes, suppressed count, and
   * messages — pinned by its serialized length and SHA-256, with the counts alongside to locate
   * a drift. Any change to what a recorded response parses to fails here.
   */
  const RECORDED: Record<
    string,
    { columns: string[]; dimensionCount: number; expected: Record<string, number | string> }
  > = {
    'd158-a82-2018-2024-both-hidden.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 0,
        caveats: 10,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 2,
        length: 5404,
        sha256: 'e2299c0b873db96d36469766b0e2d343d7fdf2454b53f50c14d8e00d56a77f9c',
      },
    },
    'd158-a82-2021-suppressed-rows-hidden.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 0,
        caveats: 10,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 2,
        length: 5475,
        sha256: '90ea42745be021d85fd438d4e9362e98b29de9a9e0df7fc6b9f6171a3d9dedac',
      },
    },
    'd158-duplicate-race-group-by.response.xml': {
      columns: ['race', 'deaths', 'population', 'crude_rate'],
      dimensionCount: 1,
      expected: {
        rows: 0,
        caveats: 0,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 1,
        length: 130,
        sha256: 'dc2675e3133c57cf1bb5e65da20225cb8eecdd451c81cb860456301aa0b46940',
      },
    },
    'd158-race-age-c00-2024.response.xml': {
      columns: ['race', 'age_group', 'deaths', 'population', 'crude_rate'],
      dimensionCount: 2,
      expected: {
        rows: 4,
        caveats: 8,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 3,
        length: 5939,
        sha256: '3d321b1bbcbe70ef56d704bb3fb9bada727f6104fc8a2fcba4a371e1b8135d41',
      },
    },
    'd176-2025-2026-partial-year.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 2,
        caveats: 10,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 6679,
        sha256: 'ab4e8758eaeb31cb964f1b97f90cb67825b9111922d59e1a67f4963b91843df6',
      },
    },
    'd176-overdose-2025-2026-lag.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 2,
        caveats: 11,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 6817,
        sha256: 'b6a14939025cebd7df40810fedc6226ff786151bd9feca89a7472ea3b2cc57fc',
      },
    },
    'd176-withheld-cause-all-years.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 1,
        caveats: 11,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 1,
        length: 7241,
        sha256: 'c8f3e0dad91abb60bbe534b4b9e12aff6963fbad65ddedc34d9680b7d147ff7d',
      },
    },
    'd76-c61-female-2019-zero-rows-hidden.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 0,
        caveats: 7,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 1,
        length: 3602,
        sha256: '94a646d5276d999b3e10497912722201cb7dd97aee7e9d5f0eb2c018c265ea69',
      },
    },
    'd76-x40-x44-by-year-2018-2019.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 2,
        caveats: 6,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 3759,
        sha256: '1675d8eb0825a16d74417abef22607a5e2bf54decc260e5752a39b8da8174432',
      },
    },
    'd76-year-age-sex-race.response.xml': {
      columns: ['year', 'age_group', 'sex', 'race', 'deaths', 'population', 'crude_rate'],
      dimensionCount: 4,
      expected: {
        rows: 2014,
        caveats: 7,
        cellNotes: 156,
        suppressedCount: 0,
        messages: 3,
        length: 392065,
        sha256: '6de52e6d5297c56d523712a278f7dc7e00c73dda2021a74b58f1b7f98b26465d',
      },
    },
    'd77-overdose-ucd-opioid-mcd-2019.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 1,
        caveats: 6,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 3555,
        sha256: '9c1056b8b58cf64e8656e99c6c75866aa68d843f7ec1e299a467f4ca0a7a2147',
      },
    },
    'd77-2019-intervals.response.xml': {
      columns: ['year', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 1,
        caveats: 6,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 3575,
        sha256: 'f204d0facdf378ea2842733545cb2b2d5322d16c7e893c80b1062b8825904dbd',
      },
    },
    'd76-x40-x49-year-age-1999-2001-intervals.response.xml': {
      columns: ['year', 'age_group', 'deaths', 'population', 'crude_rate'],
      dimensionCount: 2,
      expected: {
        rows: 35,
        caveats: 8,
        cellNotes: 7,
        suppressedCount: 0,
        messages: 2,
        length: 9559,
        sha256: '9664fd3680737208493e793cadde00e47d36da7aa0d3f0ff871843f743ac5b4f',
      },
    },
    'd76-icd-chapter-2019.response.xml': {
      columns: ['icd_chapter', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 20,
        caveats: 8,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 9922,
        sha256: 'f9489ead6ce43b28e986a5b83ea33452c0767aee41c0bca8bef11e3cf88f189f',
      },
    },
    'd76-icd-chapter-and-subchapter.response.xml': {
      columns: [
        'icd_chapter',
        'icd_subchapter',
        'deaths',
        'population',
        'crude_rate',
        'age_adjusted_rate',
      ],
      dimensionCount: 2,
      expected: {
        rows: 177,
        caveats: 14,
        cellNotes: 8,
        suppressedCount: 0,
        messages: 1,
        length: 64927,
        sha256: '1576531a0b5987f297faf30e343c5444aee684241d943adc8398f4698b2a36b1',
      },
    },
    'd176-icd-subchapter-all-years.response.xml': {
      columns: ['icd_subchapter', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 176,
        caveats: 14,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 1,
        length: 55638,
        sha256: 'e46dfacbe9701dc2316a6dfe6b114dedfb0248c144687eae7cc8dfb8d08ce910',
      },
    },
    'd176-icd-chapter-2026-lag.response.xml': {
      columns: ['icd_chapter', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 21,
        caveats: 13,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 14132,
        sha256: 'fee6bd6038032dec024b9581e848fa03af310602158ee521050cff6e8f7c616b',
      },
    },
    'd77-cause-113-2019.response.xml': {
      columns: ['cause_113', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 131,
        caveats: 11,
        cellNotes: 6,
        suppressedCount: 0,
        messages: 3,
        length: 40442,
        sha256: '74eeba5e7cd5a6f0161be8f2f5a4bb4000a316fa61eecbe308b284a08fa51a43',
      },
    },
    'd158-leading-causes-2023.response.xml': {
      columns: ['leading_causes', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 15,
        caveats: 9,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 1,
        length: 9175,
        sha256: 'a24b08bd6401f0147876bcb7cf0ffff1bebacca5f59fd1937cb813f8e8f29273',
      },
    },
    'd76-leading-causes-beside-year-rejected.response.xml': {
      columns: [
        'leading_causes',
        'year',
        'deaths',
        'population',
        'crude_rate',
        'age_adjusted_rate',
      ],
      dimensionCount: 2,
      expected: {
        rows: 0,
        caveats: 0,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 1,
        length: 155,
        sha256: '80d7a91fb4319895e55068ceecaa7f7bec078c11700fe97f744abc2fde55bc17',
      },
    },
    'd157-injury-intent-2023.response.xml': {
      columns: ['injury_intent', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 6,
        caveats: 8,
        cellNotes: 0,
        suppressedCount: 0,
        messages: 0,
        length: 6242,
        sha256: '57f3a8b5524ffa29a5f7c3476510422dba2f3e888e083caf3a98a0ed9817994d',
      },
    },
    'd176-hispanic-origin-2025.response.xml': {
      columns: ['hispanic_origin', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 3,
        caveats: 12,
        cellNotes: 3,
        suppressedCount: 0,
        messages: 0,
        length: 7952,
        sha256: 'ad9750e4d163cd3f560805be4fda0fdbd50d9b60f83d6c661cf0af9ad73f3d21',
      },
    },
    'd76-year-month-2019.response.xml': {
      columns: ['year', 'month', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 2,
      expected: {
        rows: 12,
        caveats: 5,
        cellNotes: 36,
        suppressedCount: 0,
        messages: 0,
        length: 5761,
        sha256: '046cd189641acee1c30d6f22d0f4ed492056fd6deaeb0e39b8f1f7c054b87f8b',
      },
    },
    'd176-month-2026.response.xml': {
      columns: ['month', 'deaths', 'population', 'crude_rate', 'age_adjusted_rate'],
      dimensionCount: 1,
      expected: {
        rows: 10,
        caveats: 9,
        cellNotes: 30,
        suppressedCount: 0,
        messages: 0,
        length: 6815,
        sha256: 'bd1b919da96229beedcc06615c1eef812a5c42f0ad2f2475d7e2f2b74fcacd0a',
      },
    },
  };

  it('pins every recorded response under tests/fixtures/wonder', () => {
    const recorded = readdirSync(new URL('../../fixtures/wonder/', import.meta.url)).filter(
      (name) => name.endsWith('.xml'),
    );
    expect(Object.keys(RECORDED).sort()).toEqual(recorded.sort());
  });

  it.each(Object.entries(RECORDED))(
    'parses %s exactly as recorded',
    (name, { columns, dimensionCount, expected }) => {
      const body = fixture(name);
      const table = parseDataTable(body, columns, dimensionCount);
      const messages = parseMessages(body);
      const serialized = JSON.stringify({ ...table, messages });
      expect({
        rows: table.rows.length,
        caveats: table.caveats.length,
        cellNotes: table.cellNotes.length,
        suppressedCount: table.suppressedCount,
        messages: messages.length,
        length: serialized.length,
        sha256: createHash('sha256').update(serialized).digest('hex'),
      }).toEqual(expected);
    },
  );

  it('pairs each message with the first closer after it and stops at an unclosed opener', () => {
    expect(parseMessages('<message>one</message><message>two</message><message>three')).toEqual([
      'one',
      'two',
    ]);
    expect(parseMessages('<message>one</message><message')).toEqual(['one']);
    expect(parseMessages('<message>a <message>b</message> c</message>')).toEqual(['a b']);
    /** The opening tag is `<message[^>]*>`, so a longer name that starts with it opens one. */
    expect(parseMessages('<messages><message>x</message></messages>')).toEqual(['x']);
  });

  it('reads bare caveats and word-bounded footnotes, skipping lookalike and unclosed openers', () => {
    const xml = `<caveat code="D76.C00">definition</caveat>
      <caveats><caveat>one</caveat><caveat>two</caveat><caveat>unclosed</caveats>
      <footnotes><footnote>three</footnote><footnotex>no</footnotex><footnote n="4">four</footnote><footnote</footnotes>`;
    expect(parseDataTable(xml, ['year', 'deaths'], 1).caveats).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  it('reads the first word-bounded data-table, and no rows from one that never closes', () => {
    const row = (year: string) => `<r><c l="${year}"/><c v="1"/></r>`;
    const read = (xml: string) => parseDataTable(xml, ['year', 'deaths'], 1);
    expect(
      read(
        `<data-tablex>${row('1999')}</data-table><data-table show-all-labels="true">${row('2020')}</data-table><data-table>${row('2021')}</data-table>`,
      ).rows,
    ).toEqual([{ year: '2020', deaths: 1 }]);
    expect(read(`<caveats><caveat>kept</caveat></caveats><data-table>${row('2020')}`)).toEqual({
      rows: [],
      caveats: ['kept'],
      cellNotes: [],
      suppressedCount: 0,
    });
  });

  it('reads bare rows, each to the first closer after it, and stops at an unclosed one', () => {
    const xml = `<data-table><r x="1"><c l="1998"/><c v="0"/></r><r><c l="1999"/><c v="1"/></r><r><c l="2000"/><r><c v="2"/></r><r><c l="2001"/><c v="3"/></data-table>`;
    expect(parseDataTable(xml, ['year', 'deaths'], 1).rows).toEqual([
      { year: '1999', deaths: 1 },
      { year: '2000', deaths: 2 },
    ]);
  });

  it('reads word-bounded cells to their first >, and drops a cell left open at the end', () => {
    /** Counted as a third cell, the unclosed `<c v="3` would leave too many dimension cells. */
    const xml = `<data-table><r><c l="2019"/><cx l="no"/><c v="1" a="c"><l v="(0.0 - 0.1)"/></c></r><r><c l="2020"/><c v="2"/><c v="3</r></data-table>`;
    expect(parseDataTable(xml, ['year', 'deaths'], 1).rows).toEqual([
      { year: '2019', deaths: 1 },
      { year: '2020', deaths: 2 },
    ]);
  });

  describe('cost on unclosed elements', () => {
    const table = (xml: string) => parseDataTable(xml, ['year', 'deaths'], 1);
    const cases: [string, (n: number) => string, (xml: string) => unknown][] = [
      ['<message> openers with no closer', (n) => '<message>'.repeat(n / 9), parseMessages],
      ['<message openers with no >', (n) => '<message'.repeat(n / 8), parseMessages],
      ['<caveat> openers with no closer', (n) => '<caveat>'.repeat(n / 8), table],
      ['<footnote> openers with no closer', (n) => '<footnote>'.repeat(n / 10), table],
      ['<footnote openers with no >', (n) => '<footnote '.repeat(n / 10), table],
      ['<data-table> openers with no closer', (n) => '<data-table>'.repeat(n / 12), table],
      ['<data-table openers with no >', (n) => '<data-table '.repeat(n / 12), table],
      [
        '<r> openers with no closer',
        (n) => `<data-table>${'<r>'.repeat(n / 3)}</data-table>`,
        table,
      ],
      [
        '<c openers with no >',
        (n) => `<data-table><r>${'<c '.repeat(n / 3)}</r></data-table>`,
        table,
      ],
    ];

    it.each(cases)('stays linear on %s', (_name, build, run) => expectLinearCost(build, run));
  });

  /**
   * Timing: the interval child is read inside the same forward cell scan, so a rate cell must
   * stay linear in the row however CDC sizes it. Each shape doubles from 5,000 characters, and
   * at every size the cost stays under four times the growth — a child search that runs past
   * later cells costs over 100× at 16× the input, so it fails inside the span. Shapes stay at or
   * below 80,000
   * characters, under the size where Bun's regex engine switches to a slower mode on some
   * patterns; the digit run carries the full 64× span to 320,000.
   */
  describe('timing of interval cells', () => {
    /** Enough parses per size that the 5,000-character base costs well above timer jitter. */
    const REPEATS = 50;
    const columns = ['year', 'crude_rate'];
    const expectLinear = (build: (n: number) => string, largest: number) =>
      expectLinearDoublings(build, largest, (input) => parseDataTable(input, columns, 1), REPEATS);
    const row = (cells: string) => `<data-table><r><c l="2019"/>${cells}</r></data-table>`;

    it.each([
      [
        'rate cells that never open an interval',
        (n: number) => row(fill('<c v="1" a="c"></c>', n)),
      ],
      ['interval children with no >', (n: number) => row(fill('<c a="c"><l v="(1 - 2)" ', n))],
      ['an interval opener repeated', (n: number) => row(`<c v="1" a="c">${fill('<l', n)}`)],
      [
        'complete interval cells',
        (n: number) => row(fill('<c v="1.0" a="c"><l v="(0.9 - 1.1)"/></c>', n)),
      ],
      [
        'an interval of dashes',
        (n: number) => row(`<c v="1" a="c"><l v="(${fill('-', n)})"/></c>`),
      ],
      [
        'one long line ending in a break',
        (n: number) => row(`<c v="1" a="c"><l v="${fill('§1 x', n)}\ny"/></c>`),
      ],
      [
        'line breaks throughout before the child',
        (n: number) => row(`<c v="1" a="c">${fill('  \r\n', n)}<l v="(1 - 2)"/></c>`),
      ],
      [
        'line breaks throughout and no child',
        (n: number) => row(`<c v="1" a="c">${fill('  \r\n', n)}`),
      ],
    ])('stays linear on %s', (_label, build) => {
      expectLinear(build, 80_000);
    });

    it('stays linear across the full 64× span on a long digit run', () => {
      expectLinear((n) => row(`<c v="1" a="c"><l v="(${'1'.repeat(n)} - 1)"/></c>`), 320_000);
    });
  });
});
