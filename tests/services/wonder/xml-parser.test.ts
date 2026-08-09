/**
 * @fileoverview Tests for the WONDER XML parser — `<data-table>` rows and `<message>` notices.
 * @module tests/services/wonder/xml-parser
 */

import { describe, expect, it } from 'vitest';
import { parseDataTable, parseMessages } from '@/services/wonder/xml-parser.js';

describe('parseMessages', () => {
  it('reads every message on a successful response, not just the first', () => {
    /** A rejection states its reason in the first message; a 200 stacks unrelated notices. */
    const xml = `<page>
      <message><![CDATA[Totals are not available for these results due to suppression constraints. <a href="/wonder/help/faq.html#Privacy">More Information.</a>]]></message>
      <message>Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.</message>
      <message>Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.</message>
    </page>`;
    expect(parseMessages(xml)).toEqual([
      'Totals are not available for these results due to suppression constraints. More Information.',
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

  it('extracts caveats and footnotes with CDATA and HTML stripped', () => {
    const xml = `<results>
      <data-table><r><c l="1999"/><c v="10"/></r></data-table>
      <caveats><caveat><![CDATA[Population figures <a href="x">documented here</a>.]]></caveat></caveats>
      <footnotes><footnote>Suppressed when fewer than ten deaths.</footnote></footnotes>
    </results>`;
    const { caveats } = parseDataTable(xml, ['year', 'deaths'], 1);
    expect(caveats).toEqual([
      'Population figures documented here .',
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
