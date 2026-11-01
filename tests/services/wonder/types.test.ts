/**
 * @fileoverview Tests for `hiddenRowsKind`, which reads which rows a WONDER message says CDC
 * withheld from a table — and holds its scan linear in the message length — and for
 * `reachesLagWithheldCause`, which reads whether a cause filter reaches a cause the provisional
 * database is still withholding, and for `groupingValueCounts`, the per-dimension ceilings whose
 * product bounds a table before any request.
 * @module tests/services/wonder/types
 */

import { describe, expect, it } from 'vitest';
import {
  groupingValueCounts,
  hiddenRowsKind,
  reachesLagWithheldCause,
  WONDER_CAUSE_GROUPINGS,
  WONDER_DATABASES,
  WONDER_GROUP_BY,
  WONDER_LAG_WINDOW_DAYS,
  WONDER_MAX_TABLE_ROWS,
  type WonderDatabase,
  type WonderGroupBy,
} from '@/services/wonder/types.js';
import { expectLinearDoublings, fill } from '../../helpers/cpu-cost.js';

describe('groupingValueCounts', () => {
  it('pins the table bound at 10,000 rows', () => {
    expect(WONDER_MAX_TABLE_ROWS).toBe(10_000);
  });

  /** A final database's ceilings with no filter, from its request form and its own span. */
  const finalDatabase = (years: number, race: number): Record<WonderGroupBy, number> => ({
    year: years,
    month: years * 12,
    age_group: 12,
    sex: 2,
    race,
    icd_chapter: 20,
    icd_subchapter: 177,
    cause_113: 137,
    leading_causes: 15,
    injury_intent: 6,
    hispanic_origin: 3,
  });
  const provisionalYears = new Date().getUTCFullYear() - 2017;

  /**
   * Each dimension's ceiling on every database with no filter narrowing it, written out from the
   * request forms, the database spans, and the sub-chapter counts CDC returned over each span.
   */
  const UNFILTERED: Record<WonderDatabase, Record<WonderGroupBy, number>> = {
    underlying_1999_2020: finalDatabase(22, 4),
    multiple_1999_2020: finalDatabase(22, 4),
    underlying_2018_2024: finalDatabase(7, 7),
    multiple_2018_2024: finalDatabase(7, 7),
    // The withheld-cause row is one value more in the chapter and 113-cause lists.
    provisional: { ...finalDatabase(provisionalYears, 7), icd_chapter: 21, cause_113: 138 },
  };

  it.each(WONDER_DATABASES.flatMap((db) => WONDER_GROUP_BY.map((dim) => [db, dim] as const)))(
    'counts %s grouped by %s with no filter',
    (database, dimension) => {
      expect(groupingValueCounts({ database, groupBy: [dimension] })).toEqual([
        { dimension, values: UNFILTERED[database][dimension] },
      ]);
    },
  );

  it('narrows the dimensions a filter restricts, in groupBy order', () => {
    expect(
      groupingValueCounts({
        groupBy: ['month', 'sex', 'age_group', 'year'],
        yearRange: { from: 2010, to: 2014 },
        sex: 'female',
        ageGroups: ['25-34', '35-44', 'NS'],
      }),
    ).toEqual([
      { dimension: 'month', values: 60 },
      { dimension: 'sex', values: 1 },
      { dimension: 'age_group', values: 3 },
      { dimension: 'year', values: 1, within: 'month' },
    ]);
    expect(groupingValueCounts({ groupBy: ['year'], yearRange: { from: 2010, to: 2014 } })).toEqual(
      [{ dimension: 'year', values: 5 }],
    );
  });

  it('reads an empty age-group list and sex "all" as no narrowing, and a cause filter as none', () => {
    expect(
      groupingValueCounts({
        groupBy: ['age_group', 'sex', 'icd_subchapter'],
        ageGroups: [],
        sex: 'all',
        causeIcd10: ['C00-D48'],
      }).map(({ values }) => values),
    ).toEqual([12, 2, 177]);
  });

  /**
   * A month cell is a year-month and a sub-chapter lies inside one chapter, so the finer level
   * already enumerates the coarser one: grouped together, the coarser adds no rows of its own.
   */
  it.each<[WonderGroupBy[], [WonderGroupBy, number, WonderGroupBy?][], number]>([
    [
      ['year', 'month', 'sex'],
      [
        ['year', 1, 'month'],
        ['month', 264],
        ['sex', 2],
      ],
      528,
    ],
    [
      ['month', 'sex', 'year'],
      [
        ['month', 264],
        ['sex', 2],
        ['year', 1, 'month'],
      ],
      528,
    ],
    [
      ['icd_chapter', 'icd_subchapter', 'year'],
      [
        ['icd_chapter', 1, 'icd_subchapter'],
        ['icd_subchapter', 177],
        ['year', 22],
      ],
      3_894,
    ],
    [
      ['icd_subchapter', 'year', 'icd_chapter'],
      [
        ['icd_subchapter', 177],
        ['year', 22],
        ['icd_chapter', 1, 'icd_subchapter'],
      ],
      3_894,
    ],
  ])('counts the coarser level of %j as 1 beside its finer one', (groupBy, counts, product) => {
    const values = groupingValueCounts({ groupBy });
    expect(values).toEqual(
      counts.map(([dimension, n, within]) => ({
        dimension,
        values: n,
        ...(within ? { within } : {}),
      })),
    );
    expect(values.reduce((total, { values: n }) => total * n, 1)).toBe(product);
  });

  it('keeps counting year and chapter in full when only the other level of each pair is grouped', () => {
    expect(groupingValueCounts({ groupBy: ['year', 'icd_subchapter'] })).toEqual([
      { dimension: 'year', values: 22 },
      { dimension: 'icd_subchapter', values: 177 },
    ]);
    expect(groupingValueCounts({ groupBy: ['icd_chapter', 'month'] })).toEqual([
      { dimension: 'icd_chapter', values: 20 },
      { dimension: 'month', values: 264 },
    ]);
  });

  it('names the groupings that partition deaths by underlying cause', () => {
    expect(WONDER_GROUP_BY.filter((dim) => WONDER_CAUSE_GROUPINGS.has(dim))).toEqual([
      'icd_chapter',
      'icd_subchapter',
      'cause_113',
      'leading_causes',
      'injury_intent',
    ]);
  });
});

describe('reachesLagWithheldCause', () => {
  it('pins the withheld window at 24 weeks', () => {
    expect(WONDER_LAG_WINDOW_DAYS).toBe(168);
  });

  it.each([
    [['X42'], 'underlying', true],
    [['X40-X49'], 'underlying', true],
    [['V01-Y89'], 'underlying', true],
    [['V01'], 'underlying', true],
    [['Y89.9'], 'underlying', true],
    [['R95'], 'underlying', true],
    [['R96'], 'underlying', true],
    // A chapter that contains a withheld code reaches it.
    [['R00-R99'], 'underlying', true],
    [['R94'], 'underlying', false],
    [['R97-R99'], 'underlying', false],
    [['U07.1'], 'underlying', false],
    [['Z00-Z99'], 'underlying', false],
    [['A00-B99'], 'underlying', false],
    // Any entry of a list is enough.
    [['I21', 'I22'], 'underlying', false],
    [['I21', 'Y14'], 'underlying', true],
    // Drug poisoning is withheld only as a listed cause; it is never the underlying one.
    [['T40.1'], 'underlying', false],
    [['S00-T98'], 'underlying', false],
    [['T40.1'], 'multiple', true],
    [['T36'], 'multiple', true],
    [['T50.9'], 'multiple', true],
    [['T35'], 'multiple', false],
    [['T51-T65'], 'multiple', false],
    [['S00-T98'], 'multiple', true],
    [['J09-J18'], 'multiple', false],
    [['X44'], 'multiple', true],
    // The marker counts the backlog rather than missing it.
    [['999--999'], 'underlying', false],
    [['999--999'], 'multiple', false],
    [[], 'underlying', false],
  ] as const)('reads %j on the %s finder as %s', (codes, finder, reaches) => {
    expect(reachesLagWithheldCause(codes, finder)).toBe(reaches);
  });
});

describe('hiddenRowsKind', () => {
  it.each([
    ['Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.', 'zero_deaths'],
    [
      'Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.',
      'suppressed_deaths',
    ],
    // A message naming both kinds can hide a suppressed count, so suppression wins.
    ['Rows with zero or suppressed Deaths are hidden.', 'suppressed_deaths'],
    [
      'Rows with zero Deaths are hidden. Rows with suppressed Deaths are hidden.',
      'suppressed_deaths',
    ],
    // Rows hidden for a reason CDC does not name are read the cautious way.
    ['Rows with incomplete records are hidden.', 'unspecified'],
    ['Rows with zero Deaths are hidden. Rows with incomplete records are hidden.', 'unspecified'],
    ['ROWS WITH ZERO DEATHS ARE HIDDEN.', 'zero_deaths'],
    // A sentence holding several rows→hidden spans is read whole, past its first span.
    ['Rows with zero Deaths are hidden; suppressed rows are hidden too.', 'suppressed_deaths'],
    [
      'Rows with zero Deaths are hidden; rows with incomplete records are hidden too.',
      'unspecified',
    ],
    ['Rows with zero Deaths are hidden, and rows with zero population are hidden.', 'zero_deaths'],
  ] as const)('reads %j as %s', (message, kind) => {
    expect(hiddenRowsKind(message)).toBe(kind);
  });

  it.each([
    'Totals are not available for these results due to suppression constraints. [More Information.](https://wonder.cdc.gov/wonder/help/faq.html#Privacy)',
    // "rows" and "hidden" in different sentences report nothing withheld.
    'Zero rows. Nothing is hidden.',
    // "hidden" before "rows" is not CDC's form.
    'Hidden from these rows: nothing.',
    // Whole words only.
    'Arrows are hidden.',
    '',
  ])('reads %j as no hidden rows', (message) => {
    expect(hiddenRowsKind(message)).toBeUndefined();
  });

  /**
   * Timing: a message is upstream text, so its scan must stay linear however CDC sizes it. Each
   * shape doubles from 5,000 characters while the cost stays under four times the growth — a
   * quadratic scan breaks that bound by the second doubling, before an expensive size runs.
   * Shapes stay at or below 80,000 characters, under the size where Bun's regex engine switches
   * to a slower mode on some patterns; the digit run carries the full 64× span to 320,000.
   */
  describe('timing', () => {
    /** Enough scans per size that the 5,000-character base costs about 100 µs, well above jitter. */
    const REPEATS = 200;
    const expectLinear = (build: (n: number) => string, largest: number) =>
      expectLinearDoublings(build, largest, hiddenRowsKind, REPEATS);

    it.each([
      ['an opener repeated with no closer', (n: number) => fill('rows ', n)],
      ['one sentence that opens and never closes', (n: number) => `rows ${fill('zer ', n)}`],
      [
        'one long clause between opener and closer',
        (n: number) => `rows ${fill('zero ', n)}hidden`,
      ],
      ['many complete sentences', (n: number) => fill('rows with zero deaths are hidden. ', n)],
      ['many spans in one sentence', (n: number) => fill('rows zero hidden; ', n)],
      [
        'one span, then an opener repeated with no closer',
        (n: number) => `rows hidden ${fill('rows ', n)}`,
      ],
      [
        'many spans and an opener at every step, suppression last',
        (n: number) => `${fill('rows rows zero hidden ', n)}suppressed`,
      ],
      ['one long line ending in a break', (n: number) => `${fill('§1 x', n)}\ny`],
      ['line breaks throughout', (n: number) => fill('  \r\n', n)],
    ])('stays linear on %s', (_label, build) => {
      expectLinear(build, 80_000);
    });

    it('stays linear across the full 64× span on a long digit run', () => {
      expectLinear((n) => '1'.repeat(n), 320_000);
    });
  });
});
