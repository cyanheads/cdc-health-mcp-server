/**
 * @fileoverview Tests for the WONDER `<data-table>` XML parser.
 * @module tests/services/wonder/xml-parser
 */

import { describe, expect, it } from 'vitest';
import { parseDataTable } from '@/services/wonder/xml-parser.js';

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
