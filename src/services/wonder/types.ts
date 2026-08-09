/**
 * @fileoverview Domain types for the CDC WONDER mortality service.
 * WONDER is a separate CDC system from the Socrata Open Data portal — an XML-over-HTTP
 * API for vital statistics. This service targets database D76 (Underlying Cause of Death,
 * 1999–2020), national totals only (sub-national access is restricted to the WONDER web UI).
 * @module services/wonder/types
 */

/** WONDER database this service queries. Provisional (D176) and multiple-cause (D77) diverge and are follow-ons. */
export const WONDER_DATABASE_ID = 'D76' as const;

/** Human-readable name of the queried database, for provenance in results. */
export const WONDER_DATABASE_NAME = 'Underlying Cause of Death, 1999–2020' as const;

/**
 * Dimensions results can be grouped by, mapped to D76 variable codes in the XML builder.
 * Results are always national — location grouping is not offered (CDC API policy). Cause of
 * death is a filter, not a grouping: WONDER cannot attach a population/rate to a cause-partitioned
 * row, and a deaths-only WONDER request is rejected by the upstream engine.
 */
export const WONDER_GROUP_BY = ['year', 'age_group', 'sex', 'race'] as const;
/** A dimension results can be grouped by. */
export type WonderGroupBy = (typeof WONDER_GROUP_BY)[number];

/**
 * Measures returned per row, in fixed column order. Deaths, population, and crude rate are
 * always present; age-adjusted rate is added only when WONDER can standardize by age — it
 * is dropped when age is a grouping dimension (age cannot be both a grouping dimension and
 * the standardization axis) and when the age-group filter selects exactly one group.
 */
export const WONDER_MEASURES = ['deaths', 'population', 'crude_rate', 'age_adjusted_rate'] as const;
/** A measure key. */
export type WonderMeasure = (typeof WONDER_MEASURES)[number];

/** Sex filter. */
export type WonderSex = 'all' | 'male' | 'female';

/**
 * Ten-year age group codes accepted by the age_groups filter (D76.V5 values).
 * "1" is the under-1-year group.
 */
export const WONDER_AGE_GROUPS = [
  '1',
  '1-4',
  '5-14',
  '15-24',
  '25-34',
  '35-44',
  '45-54',
  '55-64',
  '65-74',
  '75-84',
  '85+',
] as const;
/** A ten-year age group code. */
export type WonderAgeGroup = (typeof WONDER_AGE_GROUPS)[number];

/** Inclusive year range for the year filter. */
export interface WonderYearRange {
  from: number;
  to: number;
}

/** Options for a WONDER mortality query. */
export interface WonderQueryOptions {
  /** Ten-year age groups to include. Omit for all ages. */
  ageGroups?: WonderAgeGroup[] | undefined;
  /** ICD-10 underlying-cause code or range (e.g. "C00-C97"). Omit for all causes. */
  causeIcd10?: string | undefined;
  /** Dimensions to group by, in output-column order. 1–4 entries. */
  groupBy: WonderGroupBy[];
  /** Sex filter. Defaults to all. */
  sex?: WonderSex | undefined;
  /** Inclusive year range. Omit for all years (1999–2020). */
  yearRange?: WonderYearRange | undefined;
}

/**
 * One result row: dimension values (strings) and measure values keyed by friendly names.
 * A measure cell WONDER returned as a status token rather than a number is null here — the
 * matching `WonderCellNote` says which token it was.
 */
export type WonderRow = Record<string, string | number | null>;

/**
 * A measure cell WONDER returned as a status token instead of a number. WONDER writes
 * "Suppressed" (confidentiality — figures representing fewer than 10 persons), "Unreliable"
 * (a rate computed from fewer than 20 deaths, published but statistically unstable), or
 * "Not Applicable" (no population denominator) in place of the value. The cell reads null in
 * `rows`, so this record is the only thing that distinguishes those cases from each other and
 * from a genuinely absent value.
 */
export interface WonderCellNote {
  /** Measure column key whose numeric value the token replaced. */
  column: string;
  /** Zero-based index into `rows`. */
  row: number;
  /** The token exactly as WONDER returned it. */
  token: string;
}

/** True when a cell note's token is WONDER's confidentiality-suppression marker. */
export function isSuppressedToken(token: string): boolean {
  return /^suppressed$/i.test(token);
}

/** Result of a WONDER query. */
export interface WonderResult {
  /** CDC-provided caveats and footnotes for this result set. */
  caveats: string[];
  /** Measure cells WONDER returned as a status token instead of a number. */
  cellNotes: WonderCellNote[];
  /** Ordered column keys: dimensions then measures. */
  columns: string[];
  /** Database identifier the data came from (e.g. "D76"). */
  database: string;
  /** Number of rows returned. */
  rowCount: number;
  /** Result rows. Keys are the requested group-by dimensions followed by the measures. */
  rows: WonderRow[];
  /** How many of `cellNotes` carry the "Suppressed" token. */
  suppressedCount: number;
}
