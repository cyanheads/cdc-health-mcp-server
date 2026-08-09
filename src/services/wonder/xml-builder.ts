/**
 * @fileoverview Builds the CDC WONDER `request_xml` document from friendly query options.
 * WONDER expects a full `<request-parameters>` block: group-by slots (B_1..B_5), measures
 * (M_1..M_3), per-variable finder/value filters, and output options. Location is pinned to
 * national (*All*) unconditionally — the API forbids sub-national grouping or filtering.
 * Pure module (no framework imports) so it is testable in isolation.
 *
 * Three upstream-engine constraints are encoded here, discovered against the live API:
 *  - A request must carry a rate measure; a deaths-only measure set is rejected. Deaths,
 *    population, and crude rate are therefore always requested, plus the age-adjusted column
 *    via `O_aar=aar_std` when age standardization is possible (see `measuresFor`).
 *  - A specific year filter requires the year FINDER (F_) to list the years too — leaving it
 *    at *All* while V_ lists specific years is rejected as a conflicting selection.
 *  - Each database's parameter scaffold is its own. Taking D76's block and swapping the `D76.`
 *    prefix for another database's returns HTTP 500 ("The second box of the AND combination
 *    for '{0}' contains an entry while the first one is empty") — the multiple-cause databases
 *    need paired `V_*.V13`/`V_*.V13_AND` textareas D76 has no analogue for, and the provisional
 *    database carries occurrence-location, MMWR and 2023-urbanization variables D76 lacks. The
 *    scaffolds below are transcribed from each database's own request form.
 * @module services/wonder/xml-builder
 */

import {
  WONDER_DATABASE_SPECS,
  WONDER_DEFAULT_DATABASE,
  type WonderAgeGroup,
  type WonderDatabase,
  type WonderDatabaseSpec,
  type WonderGroupBy,
  type WonderMeasure,
  type WonderQueryOptions,
} from './types.js';

/**
 * Per-database wire scaffold, read off each database's own request form
 * (`POST /controller/datarequest/<ID>` with `stage=about&action-I Agree=I Agree` returns it).
 * Only the parts that vary live here; everything every form shares is templated in
 * `fixedParams`.
 */
interface FormScaffold {
  /**
   * Variables the form submits as a plain value list defaulted to *All* — the "leave every
   * other dimension unrestricted" block. `V6` is the exception WONDER seeds with `00` rather
   * than *All*, and it is handled separately.
   */
  allValues: readonly string[];
  /**
   * Variables the form submits as a finder rather than a value list, beyond the cause (`V2`),
   * year (`V1`) and location (`V9`/`V10`/`V27`) finders every database carries. Each needs
   * `F_` at *All*, an empty `V_`, and `O_V<n>_fmode` in range mode.
   */
  extraFinders: readonly string[];
  /** Output-option parameters carrying a literal value rather than a variable reference. */
  flagOptions: Readonly<Record<string, string>>;
  /** Output-option parameters naming one of this database's variables (`O_race` → `<ID>.V42`). */
  variableOptions: Readonly<Record<string, string>>;
}

/** Variables the two bridged-race databases (D76, D77) leave unrestricted. */
const BRIDGED_RACE_VALUES = [
  'V4',
  'V5',
  'V51',
  'V52',
  'V7',
  'V8',
  'V11',
  'V12',
  'V17',
  'V19',
  'V20',
  'V21',
  'V22',
  'V23',
  'V24',
  'V25',
] as const;

/** Variables the two "expanded" single-race databases (D157, D158) leave unrestricted. */
const SINGLE_RACE_VALUES = [
  'V4',
  'V5',
  'V51',
  'V52',
  'V7',
  'V11',
  'V12',
  'V17',
  'V18',
  'V19',
  'V20',
  'V21',
  'V22',
  'V23',
  'V24',
  'V25',
  'V42',
  'V43',
  'V44',
  'V45',
] as const;

const SCAFFOLDS: Record<WonderDatabase, FormScaffold> = {
  underlying_1999_2020: {
    allValues: BRIDGED_RACE_VALUES,
    extraFinders: [],
    variableOptions: {},
    flagOptions: {},
  },
  multiple_1999_2020: {
    allValues: BRIDGED_RACE_VALUES,
    extraFinders: [],
    variableOptions: {},
    flagOptions: {},
  },
  underlying_2018_2024: {
    allValues: SINGLE_RACE_VALUES,
    // Extra location detail the expanded databases expose (V30/V31 finders).
    extraFinders: ['V30', 'V31'],
    variableOptions: { O_race: 'V42' },
    flagOptions: {},
  },
  multiple_2018_2024: {
    allValues: SINGLE_RACE_VALUES,
    extraFinders: ['V30', 'V31'],
    variableOptions: { O_race: 'V42' },
    flagOptions: {},
  },
  provisional: {
    // No weekday (V24) and no V45; adds the occurrence-location value variables.
    allValues: [
      'V4',
      'V5',
      'V51',
      'V52',
      'V7',
      'V11',
      'V12',
      'V17',
      'V18',
      'V19',
      'V20',
      'V21',
      'V22',
      'V23',
      'V25',
      'V42',
      'V43',
      'V44',
      'V81',
      'V82',
      'V89',
    ],
    // Occurrence-location finders (V77/V79/V80/V90/V91) and the MMWR week finder (V100).
    extraFinders: ['V77', 'V79', 'V80', 'V90', 'V91', 'V100'],
    variableOptions: { O_race: 'V42', O_death_location: 'V79', O_death_urban: 'V89' },
    flagOptions: {
      // Date axis: YEAR groups by calendar year, MMWR by epidemiological week. The tool's
      // `year` dimension is calendar, so this stays on YEAR.
      O_dates: 'YEAR',
      O_MMWR: 'false',
      O_PR: 'false',
    },
  },
};

/**
 * Multiple-cause finder variables, as the request forms name them. `V13` (MCD - ICD-10 Codes)
 * is the finder the `mcdIcd10` filter drives; `V15` (113 Cause List), `V16` (130 Cause List,
 * Infants) and `V26` (Drug/Alcohol Induced Causes) ride along at *All* because the form submits
 * them and the engine validates the block as a whole. Each takes a paired `V_`/`V_*_AND`
 * textarea — the pair is what the prefix-swap 500 was complaining about.
 */
const MCD_FINDERS = ['V13', 'V15', 'V16', 'V26'] as const;

/** Measure → per-database measure code. No mortality database has an M4 (see `measuresFor`). */
const MEASURE_CODE = { deaths: 'M1', population: 'M2', crude_rate: 'M3' } as const;

/** Sex filter → `.V7` value. Identical on every database. */
const SEX_CODE = { all: '*All*', male: 'M', female: 'F' } as const;

/** Escape the five XML special characters in a parameter value. */
function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Serialize one `<parameter>` with one or more `<value>` children. */
function param(name: string, values: string | string[]): string {
  const list = Array.isArray(values) ? values : [values];
  const valueXml = list.map((v) => `<value>${xmlEscape(v)}</value>`).join('');
  return `<parameter><name>${name}</name>${valueXml}</parameter>`;
}

/**
 * The fixed parameter block a request against `spec` needs. WONDER rejects requests that omit
 * finder/value parameters for its variables ("must also select the button" errors), so the full
 * V_/F_/I_/O_ scaffold is always sent; dynamic filters override specific keys. Location
 * (V9/V10/V27, plus the occurrence-location finders on the provisional database) is pinned to
 * *All* here and never exposed as an input.
 *
 * `O_show_zeros` and `O_show_suppressed` are deliberately absent: sending them would return the
 * rows WONDER hides, which changes the result set materially rather than adding a field, and
 * needs its own design pass (rationale in `docs/design.md`). The hidden rows are disclosed
 * through `messages` instead.
 */
function fixedParams(
  database: WonderDatabase,
  spec: WonderDatabaseSpec,
): Record<string, string | string[]> {
  const { id } = spec;
  const scaffold = SCAFFOLDS[database];
  const params: Record<string, string | string[]> = {
    accept_datause_restrictions: 'true',
    // Underlying-cause finder (default all causes; overridden by causeIcd10)
    O_ucd: `${id}.V2`,
    [`F_${id}.V2`]: '*All*',
    [`I_${id}.V2`]: '*All* (All Causes of Death)',
    [`V_${id}.V2`]: '',
    O_V2_fmode: 'freg',
    // Year finder (filter applied via F_/V_ on .V1)
    [`F_${id}.V1`]: '*All*',
    [`I_${id}.V1`]: '*All* (All Dates)',
    [`V_${id}.V1`]: '*All*',
    O_V1_fmode: 'freg',
    // Location pinned national — not exposed
    O_location: `${id}.V9`,
    [`F_${id}.V9`]: '*All*',
    [`I_${id}.V9`]: '*All* (The United States)',
    [`V_${id}.V9`]: '',
    O_V9_fmode: 'freg',
    [`F_${id}.V10`]: '*All*',
    [`I_${id}.V10`]: '*All* (The United States)',
    [`V_${id}.V10`]: '',
    [`F_${id}.V27`]: '*All*',
    [`I_${id}.V27`]: '*All* (The United States)',
    [`V_${id}.V27`]: '*All*',
    O_V27_fmode: 'freg',
    // Remaining variable defaults (all). V6 is the one WONDER seeds with a code, not *All*.
    [`V_${id}.V6`]: '00',
  };

  for (const variable of scaffold.allValues) params[`V_${id}.${variable}`] = '*All*';

  for (const variable of scaffold.extraFinders) {
    params[`F_${id}.${variable}`] = '*All*';
    params[`V_${id}.${variable}`] = '';
    params[`O_${variable}_fmode`] = 'freg';
  }

  if (spec.multipleCause) {
    params.O_mcd = `${id}.V13`;
    for (const variable of MCD_FINDERS) {
      // V15/V16 are list-mode finders (L_), the other two range finders (F_).
      const key = variable === 'V15' || variable === 'V16' ? 'L_' : 'F_';
      params[`${key}${id}.${variable}`] = '*All*';
      params[`V_${id}.${variable}`] = '';
      params[`V_${id}.${variable}_AND`] = '';
      params[`O_${variable}_fmode`] = 'fadv';
    }
  }

  // Output options
  Object.assign(params, {
    O_age: `${id}.V5`,
    O_urban: `${id}.V19`,
    O_aar: 'aar_none',
    O_aar_pop: '0000',
    O_rate_per: '100000',
    O_precision: '1',
    O_show_totals: 'false',
    O_timeout: '300',
    O_mmode: 'on',
    O_javascript: 'on',
  });
  for (const [option, variable] of Object.entries(scaffold.variableOptions)) {
    params[option] = `${id}.${variable}`;
  }
  Object.assign(params, scaffold.flagOptions);

  return params;
}

/** Result of building a request: the XML plus the metadata the parser needs to key rows. */
export interface BuiltRequest {
  /** Ordered output column keys: group-by dimensions followed by measures. */
  columns: string[];
  /** Number of leading dimension columns (for rowspan reconstruction). */
  dimensionCount: number;
  /** The `<request-parameters>` XML document. */
  xml: string;
}

/**
 * Resolve which measures to request. Deaths, population, and crude rate are always included.
 * Age-adjusted rate is added only when WONDER can standardize across age, which rules out two
 * shapes it rejects outright: age used as a grouping dimension (it is then the output axis,
 * not the standardization axis), and an age-group filter narrowed to exactly one group
 * ("Please select more than one age group when calculating age-adjusted rates"). The conditions
 * are the same on every database.
 */
export function measuresFor(
  groupBy: WonderGroupBy[],
  ageGroups?: readonly WonderAgeGroup[] | undefined,
): WonderMeasure[] {
  const base: WonderMeasure[] = ['deaths', 'population', 'crude_rate'];
  const canAgeStandardize = !groupBy.includes('age_group') && ageGroups?.length !== 1;
  return canAgeStandardize ? [...base, 'age_adjusted_rate'] : base;
}

/** Group-by dimension → the selected database's variable code (as a B_ parameter value). */
function groupByCode(spec: WonderDatabaseSpec, dimension: WonderGroupBy): string {
  switch (dimension) {
    case 'year':
      return `${spec.id}.V1-level1`;
    case 'age_group':
      return `${spec.id}.V5`;
    case 'sex':
      return `${spec.id}.V7`;
    case 'race':
      return `${spec.id}.${spec.raceVariable}`;
  }
}

/**
 * Build the WONDER `request_xml` for a mortality query against the selected database. Measures
 * are ordered canonically (deaths, population, crude rate, age-adjusted rate) — WONDER returns
 * them in that order. Only M_1..M_3 are sent: the age-adjusted column is produced by
 * `O_aar=aar_std`, not by a measure code, and no mortality database defines an M4.
 */
export function buildRequestXml(options: WonderQueryOptions): BuiltRequest {
  const database = options.database ?? WONDER_DEFAULT_DATABASE;
  const spec = WONDER_DATABASE_SPECS[database];
  const { id } = spec;
  const params = fixedParams(database, spec);

  // Group-by slots B_1..B_5 (user order preserved; WONDER accepts any dimension order)
  for (let i = 0; i < 5; i++) {
    const dim = options.groupBy[i];
    params[`B_${i + 1}`] = dim ? groupByCode(spec, dim) : '*None*';
  }

  // Measures → M_1..M_3, plus the age-adjusted column through O_aar.
  const measures = measuresFor(options.groupBy, options.ageGroups);
  params.M_1 = `${id}.${MEASURE_CODE.deaths}`;
  params.M_2 = `${id}.${MEASURE_CODE.population}`;
  params.M_3 = `${id}.${MEASURE_CODE.crude_rate}`;
  if (measures.includes('age_adjusted_rate')) params.O_aar = 'aar_std';

  // Underlying-cause filter (finder selection)
  if (options.causeIcd10) {
    params[`F_${id}.V2`] = options.causeIcd10;
    params[`I_${id}.V2`] = options.causeIcd10;
  }

  // Multiple-cause filter — switches the .V13 finder out of the form's paired-textarea
  // advanced mode into the same range mode the underlying-cause finder uses.
  if (options.mcdIcd10 && spec.multipleCause) {
    params.O_V13_fmode = 'freg';
    params[`F_${id}.V13`] = options.mcdIcd10;
    params[`I_${id}.V13`] = options.mcdIcd10;
  }

  // Sex filter
  if (options.sex && options.sex !== 'all') params[`V_${id}.V7`] = SEX_CODE[options.sex];

  // Age-group filter (multi-value)
  if (options.ageGroups && options.ageGroups.length > 0) {
    params[`V_${id}.V5`] = [...options.ageGroups];
  }

  // Year-range filter — both the finder (F_) and value (V_) must list the years.
  if (options.yearRange) {
    const { from, to } = options.yearRange;
    const years: string[] = [];
    for (let y = from; y <= to; y++) years.push(String(y));
    params[`F_${id}.V1`] = years;
    params[`V_${id}.V1`] = years;
    params[`I_${id}.V1`] = `${from}–${to}`;
  }

  const xml = `<request-parameters>${Object.entries(params)
    .map(([name, values]) => param(name, values))
    .join('')}</request-parameters>`;

  return {
    xml,
    columns: [...options.groupBy, ...measures],
    dimensionCount: options.groupBy.length,
  };
}
