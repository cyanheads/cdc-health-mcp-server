/**
 * @fileoverview Tests for the WONDER request XML builder.
 * @module tests/services/wonder/xml-builder
 */

import { describe, expect, it } from 'vitest';
import {
  WONDER_DATABASE_SPECS,
  WONDER_DATABASES,
  type WonderDatabase,
} from '@/services/wonder/types.js';
import { buildRequestXml, measuresFor } from '@/services/wonder/xml-builder.js';

/** Read a parameter's value(s) out of the built XML. */
function values(xml: string, name: string): string[] {
  const [, block] =
    xml.match(new RegExp(`<parameter><name>${name}</name>(.*?)</parameter>`, 's')) ?? [];
  if (block === undefined) return [];
  return [...block.matchAll(/<value>(.*?)<\/value>/g)].map((m) => m[1] ?? '');
}

/** Every parameter name present in the built XML. */
function names(xml: string): string[] {
  return [...xml.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1] ?? '');
}

const ID = Object.fromEntries(
  WONDER_DATABASES.map((d) => [d, WONDER_DATABASE_SPECS[d].id]),
) as Record<WonderDatabase, string>;

/** Sorted variable suffixes and output-option names each database's request form submits. */
interface ScaffoldInventory {
  /** Variables sent as a list-mode finder (`L_`) — injury intent and mechanism. */
  listFinders: string[];
  /** Output options carrying a literal or a variable reference, excluding the `_fmode` radios. */
  outputOptions: string[];
  /** Variables sent as a finder with a range mode (`F_`). */
  rangeFinders: string[];
  /** Variables sent as a value list (`V_`), including the paired `_AND` textareas. */
  values: string[];
}

const SHARED_OUTPUT_OPTIONS = [
  'O_aar',
  'O_aar_pop',
  'O_age',
  'O_javascript',
  'O_location',
  'O_mmode',
  'O_precision',
  'O_rate_per',
  'O_show_totals',
  'O_timeout',
  'O_ucd',
  'O_urban',
];

const SCAFFOLD_INVENTORY: Record<WonderDatabase, ScaffoldInventory> = {
  underlying_1999_2020: {
    values: [
      'V1',
      'V10',
      'V11',
      'V12',
      'V17',
      'V19',
      'V2',
      'V20',
      'V21',
      'V22',
      'V23',
      'V24',
      'V25',
      'V27',
      'V4',
      'V5',
      'V51',
      'V52',
      'V6',
      'V7',
      'V8',
      'V9',
    ],
    rangeFinders: ['V1', 'V10', 'V2', 'V27', 'V9'],
    listFinders: [],
    outputOptions: SHARED_OUTPUT_OPTIONS,
  },
  provisional: {
    values: [
      'V1',
      'V10',
      'V100',
      'V11',
      'V12',
      'V13',
      'V13_AND',
      'V15',
      'V15_AND',
      'V16',
      'V16_AND',
      'V17',
      'V18',
      'V19',
      'V2',
      'V20',
      'V21',
      'V22',
      'V23',
      'V25',
      'V26',
      'V26_AND',
      'V27',
      'V4',
      'V42',
      'V43',
      'V44',
      'V5',
      'V51',
      'V52',
      'V6',
      'V7',
      'V77',
      'V79',
      'V80',
      'V81',
      'V82',
      'V89',
      'V9',
      'V90',
      'V91',
    ],
    rangeFinders: [
      'V1',
      'V10',
      'V100',
      'V13',
      'V2',
      'V26',
      'V27',
      'V77',
      'V79',
      'V80',
      'V9',
      'V90',
      'V91',
    ],
    listFinders: ['V15', 'V16'],
    outputOptions: [
      ...SHARED_OUTPUT_OPTIONS,
      'O_MMWR',
      'O_PR',
      'O_dates',
      'O_death_location',
      'O_death_urban',
      'O_mcd',
      'O_race',
    ].sort(),
  },
  underlying_2018_2024: {
    values: [
      'V1',
      'V10',
      'V11',
      'V12',
      'V17',
      'V18',
      'V19',
      'V2',
      'V20',
      'V21',
      'V22',
      'V23',
      'V24',
      'V25',
      'V27',
      'V30',
      'V31',
      'V4',
      'V42',
      'V43',
      'V44',
      'V45',
      'V5',
      'V51',
      'V52',
      'V6',
      'V7',
      'V9',
    ],
    rangeFinders: ['V1', 'V10', 'V2', 'V27', 'V30', 'V31', 'V9'],
    listFinders: [],
    outputOptions: [...SHARED_OUTPUT_OPTIONS, 'O_race'].sort(),
  },
  multiple_1999_2020: {
    values: [
      'V1',
      'V10',
      'V11',
      'V12',
      'V13',
      'V13_AND',
      'V15',
      'V15_AND',
      'V16',
      'V16_AND',
      'V17',
      'V19',
      'V2',
      'V20',
      'V21',
      'V22',
      'V23',
      'V24',
      'V25',
      'V26',
      'V26_AND',
      'V27',
      'V4',
      'V5',
      'V51',
      'V52',
      'V6',
      'V7',
      'V8',
      'V9',
    ],
    rangeFinders: ['V1', 'V10', 'V13', 'V2', 'V26', 'V27', 'V9'],
    listFinders: ['V15', 'V16'],
    outputOptions: [...SHARED_OUTPUT_OPTIONS, 'O_mcd'].sort(),
  },
  multiple_2018_2024: {
    values: [
      'V1',
      'V10',
      'V11',
      'V12',
      'V13',
      'V13_AND',
      'V15',
      'V15_AND',
      'V16',
      'V16_AND',
      'V17',
      'V18',
      'V19',
      'V2',
      'V20',
      'V21',
      'V22',
      'V23',
      'V24',
      'V25',
      'V26',
      'V26_AND',
      'V27',
      'V30',
      'V31',
      'V4',
      'V42',
      'V43',
      'V44',
      'V45',
      'V5',
      'V51',
      'V52',
      'V6',
      'V7',
      'V9',
    ],
    rangeFinders: ['V1', 'V10', 'V13', 'V2', 'V26', 'V27', 'V30', 'V31', 'V9'],
    listFinders: ['V15', 'V16'],
    outputOptions: [...SHARED_OUTPUT_OPTIONS, 'O_mcd', 'O_race'].sort(),
  },
};

describe('measuresFor', () => {
  it('includes age-adjusted rate when age is not a grouping dimension', () => {
    expect(measuresFor(['year'])).toEqual([
      'deaths',
      'population',
      'crude_rate',
      'age_adjusted_rate',
    ]);
    expect(measuresFor(['year', 'sex', 'race'])).toContain('age_adjusted_rate');
  });

  it('omits age-adjusted rate when grouping by age (age is the standardization axis)', () => {
    expect(measuresFor(['age_group'])).toEqual(['deaths', 'population', 'crude_rate']);
    expect(measuresFor(['year', 'age_group'])).not.toContain('age_adjusted_rate');
  });

  it('omits age-adjusted rate when the age-group filter selects exactly one group', () => {
    // WONDER rejects the request outright: "Please select more than one age group when
    // calculating age-adjusted rates." Grouping here is by year, so the existing
    // groupBy check cannot catch it.
    expect(measuresFor(['year'], ['1'])).toEqual(['deaths', 'population', 'crude_rate']);
    expect(measuresFor(['year', 'sex'], ['85+'])).not.toContain('age_adjusted_rate');
  });

  it('keeps age-adjusted rate for a multi-group, empty, or absent age filter', () => {
    expect(measuresFor(['year'], ['25-34', '35-44'])).toContain('age_adjusted_rate');
    expect(measuresFor(['year'], [])).toContain('age_adjusted_rate');
    expect(measuresFor(['year'], undefined)).toContain('age_adjusted_rate');
  });
});

describe('buildRequestXml', () => {
  it('defaults to D76 when no database is named, so an existing call is unchanged', () => {
    const { xml } = buildRequestXml({ groupBy: ['year'] });
    expect(values(xml, 'B_1')).toEqual(['D76.V1-level1']);
    expect(values(xml, 'M_1')).toEqual(['D76.M1']);
    expect(buildRequestXml({ groupBy: ['year'], database: 'underlying_1999_2020' }).xml).toBe(xml);
  });

  it('maps group-by dimensions to B_ slots in order and fills the rest with *None*', () => {
    const { xml, columns, dimensionCount } = buildRequestXml({ groupBy: ['year', 'sex'] });
    expect(values(xml, 'B_1')).toEqual(['D76.V1-level1']);
    expect(values(xml, 'B_2')).toEqual(['D76.V7']);
    expect(values(xml, 'B_3')).toEqual(['*None*']);
    expect(values(xml, 'B_5')).toEqual(['*None*']);
    expect(dimensionCount).toBe(2);
    expect(columns).toEqual([
      'year',
      'sex',
      'deaths',
      'population',
      'crude_rate',
      'age_adjusted_rate',
    ]);
  });

  it('requests M_1..M_3 and drives the age-adjusted column through O_aar, never an M_4', () => {
    /**
     * No mortality database defines an M4 — the age-adjusted column comes from `O_aar=aar_std`.
     * A build that sends `M_4` is asking for a measure code that does not exist.
     */
    const { xml, columns } = buildRequestXml({ groupBy: ['year'] });
    expect(values(xml, 'M_1')).toEqual(['D76.M1']);
    expect(values(xml, 'M_2')).toEqual(['D76.M2']);
    expect(values(xml, 'M_3')).toEqual(['D76.M3']);
    expect(names(xml)).not.toContain('M_4');
    expect(values(xml, 'O_aar')).toEqual(['aar_std']);
    expect(columns).toContain('age_adjusted_rate');
  });

  it('drops the age-adjusted column and uses aar_none when grouping by age', () => {
    const { xml, columns } = buildRequestXml({ groupBy: ['age_group'] });
    expect(values(xml, 'B_1')).toEqual(['D76.V5']);
    expect(values(xml, 'O_aar')).toEqual(['aar_none']);
    expect(columns).not.toContain('age_adjusted_rate');
  });

  it('sets the cause finder from causeIcd10 and leaves it at *All* otherwise', () => {
    expect(values(buildRequestXml({ groupBy: ['year'] }).xml, 'F_D76.V2')).toEqual(['*All*']);
    const { xml } = buildRequestXml({ groupBy: ['year'], causeIcd10: 'C00-C97' });
    expect(values(xml, 'F_D76.V2')).toEqual(['C00-C97']);
    expect(values(xml, 'I_D76.V2')).toEqual(['C00-C97']);
  });

  it('maps sex filter to the D76.V7 value', () => {
    expect(values(buildRequestXml({ groupBy: ['year'], sex: 'female' }).xml, 'V_D76.V7')).toEqual([
      'F',
    ]);
    expect(values(buildRequestXml({ groupBy: ['year'], sex: 'male' }).xml, 'V_D76.V7')).toEqual([
      'M',
    ]);
    expect(values(buildRequestXml({ groupBy: ['year'], sex: 'all' }).xml, 'V_D76.V7')).toEqual([
      '*All*',
    ]);
  });

  it('lists selected age groups as multiple V_D76.V5 values', () => {
    const { xml } = buildRequestXml({ groupBy: ['year'], ageGroups: ['25-34', '35-44'] });
    expect(values(xml, 'V_D76.V5')).toEqual(['25-34', '35-44']);
    expect(values(xml, 'O_aar')).toEqual(['aar_std']);
  });

  it('sends the Not Stated age group as a V5 value like any other group', () => {
    /**
     * `NS` is the twelfth `.V5` value on every database. A filter listing the eleven ten-year
     * groups without it drops the deaths CDC recorded with no age, so it has to be sendable.
     */
    const { xml } = buildRequestXml({ groupBy: ['year'], ageGroups: ['85+', 'NS'] });
    expect(values(xml, 'V_D76.V5')).toEqual(['85+', 'NS']);
    const alone = buildRequestXml({ groupBy: ['year'], ageGroups: ['NS'] });
    expect(values(alone.xml, 'V_D76.V5')).toEqual(['NS']);
    expect(values(alone.xml, 'O_aar')).toEqual(['aar_none']);
  });

  it('carries the withheld-cause marker into the provisional finders unchanged', () => {
    // `999--999` is not an ICD-10 code; it reaches the finder verbatim, like a code would.
    const { xml } = buildRequestXml({
      groupBy: ['year'],
      database: 'provisional',
      causeIcd10: '999--999',
      mcdIcd10: '999--999',
    });
    expect(values(xml, 'F_D176.V2')).toEqual(['999--999']);
    expect(values(xml, 'I_D176.V2')).toEqual(['999--999']);
    expect(values(xml, 'F_D176.V13')).toEqual(['999--999']);
    expect(values(xml, 'O_V13_fmode')).toEqual(['freg']);
  });

  it('drops the age-adjusted measure and uses aar_none for a single-group age filter', () => {
    const { xml, columns } = buildRequestXml({ groupBy: ['year'], ageGroups: ['1'] });
    expect(values(xml, 'V_D76.V5')).toEqual(['1']);
    expect(values(xml, 'O_aar')).toEqual(['aar_none']);
    expect(columns).toEqual(['year', 'deaths', 'population', 'crude_rate']);
  });

  it('expands a year range across both the finder and value parameters', () => {
    const { xml } = buildRequestXml({ groupBy: ['year'], yearRange: { from: 2018, to: 2020 } });
    expect(values(xml, 'F_D76.V1')).toEqual(['2018', '2019', '2020']);
    expect(values(xml, 'V_D76.V1')).toEqual(['2018', '2019', '2020']);
  });

  it('always pins location to national and never emits a location value', () => {
    const { xml } = buildRequestXml({
      groupBy: ['year', 'sex', 'race'],
      sex: 'male',
      causeIcd10: 'I00-I99',
    });
    expect(values(xml, 'F_D76.V9')).toEqual(['*All*']);
    expect(values(xml, 'V_D76.V9')).toEqual(['']); // present but empty — never a specific location
    expect(values(xml, 'I_D76.V9')).toEqual(['*All* (The United States)']);
  });

  it('always includes the data-use-restriction acknowledgement', () => {
    expect(
      values(buildRequestXml({ groupBy: ['year'] }).xml, 'accept_datause_restrictions'),
    ).toEqual(['true']);
  });

  describe('per-database scaffolds', () => {
    it.each(WONDER_DATABASES)('uses only %s’s own dataset prefix, in names and values', (db) => {
      /**
       * A parameter carrying another database's prefix is the shape that returns HTTP 500 —
       * the engine reads it as a variable the selected database does not have.
       */
      const { xml } = buildRequestXml({
        groupBy: ['year', 'race'],
        database: db,
        causeIcd10: 'I00-I99',
      });
      const prefixes = new Set([...xml.matchAll(/\b(D\d+)\./g)].map((m) => m[1]));
      expect([...prefixes]).toEqual([ID[db]]);
    });

    it.each(WONDER_DATABASES)('requests %s’s own measure codes', (db) => {
      const { xml } = buildRequestXml({ groupBy: ['year'], database: db });
      expect(values(xml, 'M_1')).toEqual([`${ID[db]}.M1`]);
      expect(values(xml, 'M_2')).toEqual([`${ID[db]}.M2`]);
      expect(values(xml, 'M_3')).toEqual([`${ID[db]}.M3`]);
      expect(names(xml)).not.toContain('M_4');
    });

    it.each(WONDER_DATABASES)('pins location to national on %s', (db) => {
      const { xml } = buildRequestXml({ groupBy: ['year'], database: db });
      expect(values(xml, `F_${ID[db]}.V9`)).toEqual(['*All*']);
      expect(values(xml, `V_${ID[db]}.V9`)).toEqual(['']);
      expect(values(xml, `F_${ID[db]}.V10`)).toEqual(['*All*']);
      expect(values(xml, `F_${ID[db]}.V27`)).toEqual(['*All*']);
    });

    it.each([
      ['underlying_1999_2020', 'V8'],
      ['multiple_1999_2020', 'V8'],
      ['underlying_2018_2024', 'V42'],
      ['multiple_2018_2024', 'V42'],
      ['provisional', 'V42'],
    ] as const)('groups race by %s’s own race variable (%s)', (db, variable) => {
      /**
       * The one dimension that genuinely diverges: bridged race (V8, four groups) versus
       * single race (V42, six plus multiracial). Sending the wrong one silently returns a
       * different vocabulary rather than failing.
       */
      const { xml } = buildRequestXml({ groupBy: ['race'], database: db });
      expect(values(xml, 'B_1')).toEqual([`${ID[db]}.${variable}`]);
    });

    it.each(['multiple_1999_2020', 'multiple_2018_2024', 'provisional'] as const)(
      'sends the paired multiple-cause textareas on %s',
      (db) => {
        /**
         * The pair is what the prefix-swap 500 complains about — "the second box of the AND
         * combination contains an entry while the first one is empty". Both must be present.
         */
        const { xml } = buildRequestXml({ groupBy: ['year'], database: db });
        expect(values(xml, 'O_mcd')).toEqual([`${ID[db]}.V13`]);
        for (const variable of ['V13', 'V15', 'V16', 'V26']) {
          expect(values(xml, `V_${ID[db]}.${variable}`)).toEqual(['']);
          expect(values(xml, `V_${ID[db]}.${variable}_AND`)).toEqual(['']);
          expect(values(xml, `O_${variable}_fmode`)).toEqual(['fadv']);
        }
      },
    );

    it.each(['underlying_1999_2020', 'underlying_2018_2024'] as const)(
      'sends no multiple-cause scaffold on %s',
      (db) => {
        const { xml } = buildRequestXml({ groupBy: ['year'], database: db });
        expect(names(xml)).not.toContain('O_mcd');
        expect(names(xml)).not.toContain(`V_${ID[db]}.V13`);
      },
    );

    it.each(['multiple_1999_2020', 'multiple_2018_2024', 'provisional'] as const)(
      'switches %s’s multiple-cause finder to range mode when mcdIcd10 is set',
      (db) => {
        const { xml } = buildRequestXml({
          groupBy: ['year'],
          database: db,
          mcdIcd10: 'J00-J98',
        });
        expect(values(xml, 'O_V13_fmode')).toEqual(['freg']);
        expect(values(xml, `F_${ID[db]}.V13`)).toEqual(['J00-J98']);
        expect(values(xml, `I_${ID[db]}.V13`)).toEqual(['J00-J98']);
        // The paired textareas stay empty — the range mode reads F_, not the AND boxes.
        expect(values(xml, `V_${ID[db]}.V13`)).toEqual(['']);
        expect(values(xml, `V_${ID[db]}.V13_AND`)).toEqual(['']);
      },
    );

    it('ignores mcdIcd10 on a database with no multiple-cause finder', () => {
      /** The tool rejects this combination; the builder must not invent a V13 if it slips past. */
      const { xml } = buildRequestXml({
        groupBy: ['year'],
        database: 'underlying_1999_2020',
        mcdIcd10: 'J00-J98',
      });
      expect(names(xml)).not.toContain('F_D76.V13');
      expect(values(xml, 'O_V13_fmode')).toEqual([]);
    });

    it('carries the provisional database’s own variables and omits D76-only ones', () => {
      /**
       * D176 has occurrence-location, MMWR-week and 2023-urbanization variables D76 lacks, and
       * lacks D76's weekday variable. Both directions matter: a missing one is a 500, and
       * D76's weekday variable sent to D176 names a variable it does not have.
       */
      const { xml } = buildRequestXml({ groupBy: ['year'], database: 'provisional' });
      const present = names(xml);
      for (const variable of ['V77', 'V79', 'V80', 'V90', 'V91', 'V100']) {
        expect(values(xml, `F_D176.${variable}`)).toEqual(['*All*']);
        expect(values(xml, `O_${variable}_fmode`)).toEqual(['freg']);
      }
      expect(values(xml, 'O_dates')).toEqual(['YEAR']);
      expect(values(xml, 'O_race')).toEqual(['D176.V42']);
      expect(present).not.toContain('V_D176.V24');
      expect(present).not.toContain('V_D176.V8');
    });

    it('carries the census finders the expanded databases add', () => {
      const { xml } = buildRequestXml({ groupBy: ['year'], database: 'underlying_2018_2024' });
      for (const variable of ['V30', 'V31']) {
        expect(values(xml, `F_D158.${variable}`)).toEqual(['*All*']);
        expect(values(xml, `O_${variable}_fmode`)).toEqual(['freg']);
      }
      expect(values(xml, 'O_race')).toEqual(['D158.V42']);
      expect(names(xml)).not.toContain('V_D158.V8');
    });

    it('sends no race output option on the bridged-race databases, which have none', () => {
      for (const db of ['underlying_1999_2020', 'multiple_1999_2020'] as const) {
        const { xml } = buildRequestXml({ groupBy: ['year'], database: db });
        expect(names(xml)).not.toContain('O_race');
        expect(values(xml, `V_${ID[db]}.V8`)).toEqual(['*All*']);
      }
    });

    it.each(WONDER_DATABASES)('never sends O_show_zeros or O_show_suppressed on %s', (db) => {
      /**
       * Unhiding the rows WONDER drops changes the result set materially and is deliberately
       * not done — the hidden rows are disclosed through `messages` instead.
       */
      const present = names(buildRequestXml({ groupBy: ['year'], database: db }).xml);
      expect(present).not.toContain('O_show_zeros');
      expect(present).not.toContain('O_show_suppressed');
    });

    it.each(WONDER_DATABASES)('submits %s’s whole scaffold, no more and no less', (db) => {
      /**
       * The assertion of record for `SCAFFOLDS`. Every other case in this block checks one
       * variable at a time, so dropping an entry — an occurrence-location value, a census
       * finder, a race output option, the infant-age seed — leaves them all green while the
       * request on the wire changes. Both failure modes are silent until a live call: a
       * variable the database does not have returns HTTP 500, and one it expects but does not
       * receive returns a "must also select the button" rejection.
       *
       * The expected sets are transcribed from each database's own request form
       * (`POST /controller/datarequest/<ID>` with `stage=about&action-I Agree=I Agree`).
       * `F_<ID>.V25` and the `O_V10_fmode`/`O_V25_fmode` modes appear on every form and are
       * deliberately not sent — D76 has never sent them and is accepted, so leaving them out
       * is the established shape rather than an omission to correct.
       */
      const { xml } = buildRequestXml({ groupBy: ['year'], database: db });
      const suffixes = (prefix: string) =>
        names(xml)
          .filter((n) => n.startsWith(`${prefix}${ID[db]}.`))
          .map((n) => n.slice(prefix.length + ID[db].length + 1))
          .sort();
      const expected = SCAFFOLD_INVENTORY[db];

      expect(suffixes('V_')).toEqual(expected.values);
      expect(suffixes('F_')).toEqual(expected.rangeFinders);
      expect(suffixes('L_')).toEqual(expected.listFinders);
      expect(
        names(xml)
          .filter((n) => /^O_/.test(n) && !n.endsWith('_fmode'))
          .sort(),
      ).toEqual(expected.outputOptions);
      // V6 (infant age) is the one variable WONDER seeds with a code rather than *All*.
      expect(values(xml, `V_${ID[db]}.V6`)).toEqual(['00']);
    });
  });
});
