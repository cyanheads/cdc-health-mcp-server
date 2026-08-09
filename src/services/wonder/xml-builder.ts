/**
 * @fileoverview Builds the CDC WONDER `request_xml` document from friendly query options.
 * WONDER expects a full `<request-parameters>` block: group-by slots (B_1..B_5), measures
 * (M_1..M_n), per-variable finder/value filters, and output options. Location is pinned to
 * national (*All*) unconditionally — the API forbids sub-national grouping or filtering.
 * Pure module (no framework imports) so it is testable in isolation.
 *
 * Two upstream-engine constraints are encoded here, discovered against the live API:
 *  - A request must carry a rate measure; a deaths-only measure set is rejected. Deaths,
 *    population, and crude rate are therefore always requested, plus age-adjusted rate when
 *    age standardization is possible (see `measuresFor`).
 *  - A specific year filter requires the year FINDER (F_) to list the years too — leaving it
 *    at *All* while V_ lists specific years is rejected as a conflicting selection.
 * @module services/wonder/xml-builder
 */

import {
  WONDER_MEASURES,
  type WonderAgeGroup,
  type WonderGroupBy,
  type WonderMeasure,
  type WonderQueryOptions,
} from './types.js';

/** Group-by dimension → D76 variable code (as a B_ parameter value). */
const GROUP_BY_CODE: Record<WonderGroupBy, string> = {
  year: 'D76.V1-level1',
  age_group: 'D76.V5',
  sex: 'D76.V7',
  race: 'D76.V8',
};

/** Measure → D76 measure code. */
const MEASURE_CODE: Record<WonderMeasure, string> = {
  deaths: 'D76.M1',
  population: 'D76.M2',
  crude_rate: 'D76.M3',
  age_adjusted_rate: 'D76.M4',
};

/** Sex filter → D76.V7 value. */
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
 * The fixed D76 parameter block that every request needs. WONDER rejects requests that
 * omit finder/value parameters for its variables ("must also select the button" errors),
 * so the full V_/F_/I_/O_ scaffold is always sent; dynamic filters override specific keys.
 * Location (V9/V10/V27) is pinned to *All* here and never exposed as an input.
 */
function fixedParams(): Record<string, string | string[]> {
  return {
    accept_datause_restrictions: 'true',
    // Cause finder (default all causes; overridden by causeIcd10)
    O_ucd: 'D76.V2',
    'F_D76.V2': '*All*',
    'I_D76.V2': '*All* (All Causes of Death)',
    'V_D76.V2': '',
    O_V2_fmode: 'freg',
    // Year finder (filter applied via F_/V_D76.V1)
    'F_D76.V1': '*All*',
    'I_D76.V1': '*All* (All Dates)',
    'V_D76.V1': '*All*',
    O_V1_fmode: 'freg',
    // Location pinned national — not exposed
    O_location: 'D76.V9',
    'F_D76.V9': '*All*',
    'I_D76.V9': '*All* (The United States)',
    'V_D76.V9': '',
    O_V9_fmode: 'freg',
    'F_D76.V10': '*All*',
    'I_D76.V10': '*All* (The United States)',
    'V_D76.V10': '',
    'F_D76.V27': '*All*',
    'I_D76.V27': '*All* (The United States)',
    'V_D76.V27': '*All*',
    O_V27_fmode: 'freg',
    // Remaining variable defaults (all)
    'V_D76.V4': '*All*',
    'V_D76.V5': '*All*',
    'V_D76.V51': '*All*',
    'V_D76.V52': '*All*',
    'V_D76.V6': '00',
    'V_D76.V7': '*All*',
    'V_D76.V8': '*All*',
    'V_D76.V11': '*All*',
    'V_D76.V12': '*All*',
    'V_D76.V17': '*All*',
    'V_D76.V19': '*All*',
    'V_D76.V20': '*All*',
    'V_D76.V21': '*All*',
    'V_D76.V22': '*All*',
    'V_D76.V23': '*All*',
    'V_D76.V24': '*All*',
    'V_D76.V25': '*All*',
    // Output options
    O_age: 'D76.V5',
    O_urban: 'D76.V19',
    O_aar: 'aar_none',
    O_aar_pop: '0000',
    O_rate_per: '100000',
    O_precision: '1',
    O_show_totals: 'false',
    O_timeout: '300',
    O_mmode: 'on',
    O_javascript: 'on',
  };
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
 * ("Please select more than one age group when calculating age-adjusted rates").
 */
export function measuresFor(
  groupBy: WonderGroupBy[],
  ageGroups?: readonly WonderAgeGroup[] | undefined,
): WonderMeasure[] {
  const base: WonderMeasure[] = ['deaths', 'population', 'crude_rate'];
  const canAgeStandardize = !groupBy.includes('age_group') && ageGroups?.length !== 1;
  return canAgeStandardize ? [...base, 'age_adjusted_rate'] : base;
}

/**
 * Build the WONDER `request_xml` for a D76 mortality query. Measures are ordered canonically
 * (deaths, population, crude rate, age-adjusted rate) — WONDER returns them in that order.
 */
export function buildRequestXml(options: WonderQueryOptions): BuiltRequest {
  const params = fixedParams();

  // Group-by slots B_1..B_5 (user order preserved; WONDER accepts any dimension order)
  for (let i = 0; i < 5; i++) {
    const dim = options.groupBy[i];
    params[`B_${i + 1}`] = dim ? GROUP_BY_CODE[dim] : '*None*';
  }

  // Measures (canonical order) → M_1..M_n
  const selected = measuresFor(options.groupBy, options.ageGroups);
  const measures = WONDER_MEASURES.filter((m) => selected.includes(m));
  measures.forEach((m, i) => {
    params[`M_${i + 1}`] = MEASURE_CODE[m];
  });
  if (measures.includes('age_adjusted_rate')) params.O_aar = 'aar_std';

  // Cause filter (finder selection)
  if (options.causeIcd10) {
    params['F_D76.V2'] = options.causeIcd10;
    params['I_D76.V2'] = options.causeIcd10;
  }

  // Sex filter
  if (options.sex && options.sex !== 'all') params['V_D76.V7'] = SEX_CODE[options.sex];

  // Age-group filter (multi-value)
  if (options.ageGroups && options.ageGroups.length > 0) {
    params['V_D76.V5'] = [...options.ageGroups];
  }

  // Year-range filter — both the finder (F_) and value (V_) must list the years.
  if (options.yearRange) {
    const { from, to } = options.yearRange;
    const years: string[] = [];
    for (let y = from; y <= to; y++) years.push(String(y));
    params['F_D76.V1'] = years;
    params['V_D76.V1'] = years;
    params['I_D76.V1'] = `${from}–${to}`;
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
