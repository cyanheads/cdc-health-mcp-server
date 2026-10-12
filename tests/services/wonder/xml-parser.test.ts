/**
 * @fileoverview Tests for the WONDER XML parser — `<data-table>` rows and `<message>` notices.
 * @module tests/services/wonder/xml-parser
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDataTable, parseMessages } from '@/services/wonder/xml-parser.js';
import { expectLinearCost } from '../../helpers/cpu-cost.js';

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
    expect(rows).toEqual([
      { year: '1999', deaths: 2391399, population: 279040168, crude_rate: 857 },
      { year: '2000', deaths: 2403351, population: 281421906, crude_rate: 854 },
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
    // "Unreliable" (rate from < 20 deaths) and "Not Applicable" (no denominator) are published
    // values CDC flagged, not withheld ones — they must not read as suppression.
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
        length: 5759,
        sha256: '6e12cf372c4a489f829ca48eb42439af5779b374e3fbb209a30b8997b2756a1b',
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
        length: 3539,
        sha256: '3fffe5f1a48ebd9459bd8458a665cb042a6679d21be55975f4d3a547199f2061',
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
        length: 295393,
        sha256: 'ea3d42d64ab08c592cccb6003f4de1181ca09d22f56d2c145bfece47f985f963',
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
        length: 3445,
        sha256: '1afa3f63b6935ac240cf30151a879c1bbbc65de323f9df1d348fd2cbbf68ef03',
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
});
