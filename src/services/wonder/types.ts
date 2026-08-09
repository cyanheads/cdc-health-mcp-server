/**
 * @fileoverview Domain types for the CDC WONDER mortality service.
 * WONDER is a separate CDC system from the Socrata Open Data portal — an XML-over-HTTP
 * API for vital statistics. This service reaches five mortality databases, national totals
 * only (sub-national access is restricted to the WONDER web UI).
 * @module services/wonder/types
 */

/**
 * Mortality databases this service can query, ordered by how much each adds over the default.
 * Every one is national-only and shares the same grouping dimensions, measures, and
 * underlying-cause finder; they differ in the years they hold, which race vocabulary they use,
 * and whether they carry a multiple-cause finder.
 */
export const WONDER_DATABASES = [
  'underlying_1999_2020',
  'provisional',
  'underlying_2018_2024',
  'multiple_1999_2020',
  'multiple_2018_2024',
] as const;
/** A selectable WONDER mortality database. */
export type WonderDatabase = (typeof WONDER_DATABASES)[number];

/** Default database — the one the tool queried before the selector existed. */
export const WONDER_DEFAULT_DATABASE: WonderDatabase = 'underlying_1999_2020';

/**
 * The provisional database rolls forward continuously ("2018 through Last Week"), so its last
 * year is whatever year it is now rather than a figure baked into the source. Read once at
 * module load — a mortality database gaining a year mid-process is not a case worth handling.
 */
const CURRENT_YEAR = new Date().getUTCFullYear();

/**
 * The pseudo-code CDC lists in the provisional database's ICD-10 finders for deaths whose
 * cause is withheld under its six-month reporting lag ("Data not shown due to 6 month lag to
 * account for delays in death certificate completion for certain causes of death"). It is not
 * an ICD-10 code and does not fit their form, so it is accepted as its own literal; the
 * databases whose finders do not list it reject it as an invalid code.
 */
export const WONDER_LAG_WITHHELD_CAUSE = '999--999';

/** What distinguishes one WONDER mortality database from another. */
export interface WonderDatabaseSpec {
  /** First year the database holds. */
  firstYear: number;
  /** WONDER dataset code, e.g. "D76" — the last path segment of the controller URL. */
  id: string;
  /**
   * True when the database's ICD-10 finders list `WONDER_LAG_WITHHELD_CAUSE`. Only the
   * provisional database does — the final ones carry no withheld-cause backlog.
   */
  lagWithheldCause: boolean;
  /** Last year the database holds. */
  lastYear: number;
  /**
   * True when the database carries a multiple-cause finder (`.V13`) — a filter on any cause
   * listed anywhere on the death certificate, not just the one certified as underlying.
   */
  multipleCause: boolean;
  /**
   * Variable backing the `race` grouping. `V8` is bridged race (4 groups, Asian and Pacific
   * Islander collapsed into one); `V42` is single race (6 groups plus multiracial). The two
   * families return different labels and are not comparable with each other.
   */
  raceVariable: 'V8' | 'V42';
  /** WONDER's own title for the database, as its request form reports it. */
  title: string;
  /**
   * The underlying-cause database covering the same years, when one exists. A multiple-cause
   * database queried without a multiple-cause filter still counts each death once, by its
   * underlying cause, so it returns that database's figures to the digit — which makes the
   * selection a no-op worth flagging. The provisional database has no twin: its years run past
   * where the final databases stop, so it is worth selecting on recency alone.
   */
  underlyingCauseTwin?: WonderDatabase;
}

/**
 * Verified against each database's own request form and a request that returned real data.
 * The IDs are pinned rather than resolved per call: `GET /controller/datarequest/<ID>` names
 * the request page an ID belongs to and a retired ID names none, which is what the ID-stability
 * test checks — a resolver on every call would buy nothing and add a failure mode.
 */
export const WONDER_DATABASE_SPECS: Record<WonderDatabase, WonderDatabaseSpec> = {
  underlying_1999_2020: {
    id: 'D76',
    title: 'Underlying Cause of Death, 1999-2020',
    firstYear: 1999,
    lastYear: 2020,
    raceVariable: 'V8',
    multipleCause: false,
    lagWithheldCause: false,
  },
  provisional: {
    id: 'D176',
    title: 'Provisional Mortality Statistics, 2018 through Last Week',
    firstYear: 2018,
    lastYear: CURRENT_YEAR,
    raceVariable: 'V42',
    multipleCause: true,
    lagWithheldCause: true,
  },
  underlying_2018_2024: {
    id: 'D158',
    title: 'Underlying Cause of Death, 2018-2024, Single Race',
    firstYear: 2018,
    lastYear: 2024,
    raceVariable: 'V42',
    multipleCause: false,
    lagWithheldCause: false,
  },
  multiple_1999_2020: {
    id: 'D77',
    title: 'Multiple Cause of Death, 1999-2020',
    firstYear: 1999,
    lastYear: 2020,
    raceVariable: 'V8',
    multipleCause: true,
    lagWithheldCause: false,
    underlyingCauseTwin: 'underlying_1999_2020',
  },
  multiple_2018_2024: {
    id: 'D157',
    title: 'Multiple Cause of Death, 2018-2024, Single Race',
    firstYear: 2018,
    lastYear: 2024,
    raceVariable: 'V42',
    multipleCause: true,
    lagWithheldCause: false,
    underlyingCauseTwin: 'underlying_2018_2024',
  },
};

/**
 * Union of every database's year span. The `year_range` input carries these as plain numeric
 * bounds so the emitted JSON Schema states a range a client can read; the span of the database
 * actually selected is narrower and is enforced in the handler, where a rejection can carry a
 * recovery hint naming that database's real span.
 */
export const WONDER_YEAR_BOUNDS = {
  first: Math.min(...Object.values(WONDER_DATABASE_SPECS).map((d) => d.firstYear)),
  last: Math.max(...Object.values(WONDER_DATABASE_SPECS).map((d) => d.lastYear)),
} as const;

/** Resolve a database selection to its specification. */
export function wonderDatabaseSpec(database?: WonderDatabase | undefined): WonderDatabaseSpec {
  return WONDER_DATABASE_SPECS[database ?? WONDER_DEFAULT_DATABASE];
}

/**
 * Dimensions results can be grouped by, mapped to per-database variable codes in the XML
 * builder. Results are always national — location grouping is not offered (CDC API policy).
 * Cause of death is a filter, not a grouping: WONDER cannot attach a population/rate to a
 * cause-partitioned row, and a deaths-only WONDER request is rejected by the upstream engine.
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
 * Age group codes accepted by the age_groups filter — the complete `.V5` value list, which is
 * identical on every database. "1" is the under-1-year group. "NS" is the group CDC puts deaths
 * in when the age was not recorded; it is the twelfth value, and leaving it out of a filter
 * drops those deaths, which is why the filter carries it rather than offering the eleven
 * ten-year groups alone.
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
  'NS',
] as const;
/** An age group code. */
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
  /** Database to query. Defaults to `underlying_1999_2020` (D76). */
  database?: WonderDatabase | undefined;
  /** Dimensions to group by, in output-column order. 1–4 entries. */
  groupBy: WonderGroupBy[];
  /**
   * ICD-10 code or range to match against any cause listed on the death certificate. Only
   * meaningful on a database whose spec has `multipleCause` — the callers reject it elsewhere.
   */
  mcdIcd10?: string | undefined;
  /** Sex filter. Defaults to all. */
  sex?: WonderSex | undefined;
  /** Inclusive year range within the selected database's span. Omit for all years. */
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

/**
 * True when a WONDER message reports that whole rows were withheld from the table — "Rows with
 * zero Deaths are hidden." and "Rows with suppressed Deaths are hidden." are the two every
 * mortality database emits. A hidden row never reaches `rows` at all, so unlike a suppressed
 * *cell* nothing in the table marks its absence; the message is the only evidence it existed.
 */
export function isHiddenRowsMessage(message: string): boolean {
  return /\brows\b[^.]*\bhidden\b/i.test(message);
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
  /** WONDER's own title for that database, so a result names its source without a lookup. */
  databaseTitle: string;
  /**
   * Informational messages WONDER returned with the table. Present when the row set was
   * filtered before it was sent (rows with zero or suppressed deaths are hidden by default);
   * empty when nothing was withheld.
   */
  messages: string[];
  /** Number of rows returned. */
  rowCount: number;
  /** Result rows. Keys are the requested group-by dimensions followed by the measures. */
  rows: WonderRow[];
  /** How many of `cellNotes` carry the "Suppressed" token. */
  suppressedCount: number;
}
