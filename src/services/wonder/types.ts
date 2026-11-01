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

/** Default database. */
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

/**
 * The code the same withheld-cause stratum carries as a sub-chapter: grouped by ICD sub-chapter,
 * the provisional database's withheld-cause row reads `999-999` where the chapter row reads
 * `WONDER_LAG_WITHHELD_CAUSE`. Only the chapter form is a verified finder value, so a filter
 * given this one is sent as that.
 */
export const WONDER_LAG_WITHHELD_SUBCHAPTER_CODE = '999-999';

/**
 * How far back from its data-through date the provisional database withholds the causes in
 * `LAG_WITHHELD_SPANS`: deaths in the 24 weeks before it are counted under
 * `WONDER_LAG_WITHHELD_CAUSE` until CDC releases their cause.
 */
export const WONDER_LAG_WINDOW_DAYS = 24 * 7;

/** Which cause finder a filter drives: the underlying cause, or any cause on the certificate. */
export type WonderCauseFinder = 'underlying' | 'multiple';

/**
 * The ICD-10 spans, first and last three-character code, whose cause the provisional database
 * withholds inside its lag window: external causes of injury (V01-Y89) and sudden deaths (R95,
 * R96), plus drug poisoning (T36-T50) on the multiple-cause finder — those codes describe the
 * poisoning on the certificate and are never certified as the underlying cause.
 */
const LAG_WITHHELD_SPANS: Record<WonderCauseFinder, readonly (readonly [string, string])[]> = {
  underlying: [
    ['V01', 'Y89'],
    ['R95', 'R96'],
  ],
  multiple: [
    ['V01', 'Y89'],
    ['R95', 'R96'],
    ['T36', 'T50'],
  ],
};

/**
 * The place in A00…Z99 of the three-character ICD-10 category a code opens with (`T40.1` → T40),
 * or NaN for anything else — which no span comparison matches.
 */
function icd10Ordinal(code: string): number {
  const letter = code.charCodeAt(0) - 65;
  const digits = code.slice(1, 3);
  return letter >= 0 && letter <= 25 && /^\d\d$/.test(digits)
    ? letter * 100 + Number(digits)
    : Number.NaN;
}

/**
 * True when a cause filter reaches a cause the provisional database withholds inside its lag
 * window. `codes` are entries as the cause filters take them — a code (`X42`, `T40.1`), or a
 * block or chapter range (`X40-X49`, `R00-R99`) — and an entry reaches a withheld cause when its
 * span overlaps one, so a chapter that contains R95 counts as much as R95 itself. The
 * withheld-cause marker reaches none: it counts the backlog rather than missing it. Each entry is
 * a short, schema-checked string, so the work is bounded by the entry count.
 */
export function reachesLagWithheldCause(
  codes: readonly string[],
  finder: WonderCauseFinder,
): boolean {
  return codes.some((code) => {
    const [first = '', last = first] = code.split('-');
    const from = icd10Ordinal(first);
    const to = icd10Ordinal(last);
    return LAG_WITHHELD_SPANS[finder].some(
      ([start, end]) => from <= icd10Ordinal(end) && to >= icd10Ordinal(start),
    );
  });
}

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
   * Islander collapsed into one); `V42` is single race (6 categories, "More than one race"
   * among them). The two families return different labels and are not comparable with each
   * other.
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
  /**
   * When CDC flags a rate on this database "Unreliable", as the caveat it attaches to every
   * result states the rule, phrased to follow "when". The final 1999–2020 pair judges by the
   * death count ("a numerator of 20 or less"); the other three by the interval ("the relative
   * confidence interval width exceeds 160% of the rate"), whatever the count. Either way the
   * token replaces the rate.
   */
  unreliableCriterion: string;
}

/** The 1999–2020 databases' caveat: "a numerator of 20 or less". */
const UNRELIABLE_BY_DEATH_COUNT = 'it is computed from 20 or fewer deaths';
/** The 2018-on databases' caveat: "the relative confidence interval width exceeds 160% of the rate". */
const UNRELIABLE_BY_INTERVAL_WIDTH =
  'its 95% confidence interval is wider than 160% of the rate, whatever the death count';

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
    unreliableCriterion: UNRELIABLE_BY_DEATH_COUNT,
    firstYear: 1999,
    lastYear: 2020,
    raceVariable: 'V8',
    multipleCause: false,
    lagWithheldCause: false,
  },
  provisional: {
    id: 'D176',
    title: 'Provisional Mortality Statistics, 2018 through Last Week',
    unreliableCriterion: UNRELIABLE_BY_INTERVAL_WIDTH,
    firstYear: 2018,
    lastYear: CURRENT_YEAR,
    raceVariable: 'V42',
    multipleCause: true,
    lagWithheldCause: true,
  },
  underlying_2018_2024: {
    id: 'D158',
    title: 'Underlying Cause of Death, 2018-2024, Single Race',
    unreliableCriterion: UNRELIABLE_BY_INTERVAL_WIDTH,
    firstYear: 2018,
    lastYear: 2024,
    raceVariable: 'V42',
    multipleCause: false,
    lagWithheldCause: false,
  },
  multiple_1999_2020: {
    id: 'D77',
    title: 'Multiple Cause of Death, 1999-2020',
    unreliableCriterion: UNRELIABLE_BY_DEATH_COUNT,
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
    unreliableCriterion: UNRELIABLE_BY_INTERVAL_WIDTH,
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
 * The specification of the database a result names by its WONDER code (`WonderResult.database`,
 * e.g. "D158") — for a reader holding only the result. Undefined for a code no spec carries.
 */
export function wonderDatabaseSpecById(id: string): WonderDatabaseSpec | undefined {
  return Object.values(WONDER_DATABASE_SPECS).find((spec) => spec.id === id);
}

/**
 * Dimensions results can be grouped by, mapped to per-database variable codes in the XML
 * builder. Results are always national — location grouping is not offered (CDC API policy).
 * Five of them partition deaths by underlying cause (see `WONDER_CAUSE_GROUPINGS`), and WONDER
 * attaches the full population and both rates to every cause row, as it does to any other
 * stratum. `month` is the exception on the measure side: CDC publishes no monthly population,
 * so its rows carry deaths alone, with population and both rates "Not Applicable".
 */
export const WONDER_GROUP_BY = [
  'year',
  'age_group',
  'sex',
  'race',
  'icd_chapter',
  'icd_subchapter',
  'cause_113',
  'leading_causes',
  'injury_intent',
  'hispanic_origin',
  'month',
] as const;
/** A dimension results can be grouped by. */
export type WonderGroupBy = (typeof WONDER_GROUP_BY)[number];

/**
 * The groupings that partition deaths by their underlying cause: ICD-10 chapter and
 * sub-chapter, CDC's 113-cause list, its 15 leading causes, and injury intent (which CDC derives
 * from the external-cause code). On the provisional database each inherits the reporting lag —
 * inside the 24-week window the withheld causes' deaths sit under `WONDER_LAG_WITHHELD_CAUSE`
 * rather than in their own cause's row, so those rows run low.
 */
export const WONDER_CAUSE_GROUPINGS: ReadonlySet<WonderGroupBy> = new Set<WonderGroupBy>([
  'icd_chapter',
  'icd_subchapter',
  'cause_113',
  'leading_causes',
  'injury_intent',
]);

/** A code CDC sends on a grouping's cells beside the label, and the row key it becomes. */
export interface WonderDimensionCode {
  /** The cell attribute CDC writes it in. */
  attribute: 'cd' | 'h';
  /** The grouping whose cells carry it. */
  dimension: WonderGroupBy;
  /** The row key it is read into, placed after the dimensions and before the measures. */
  key: 'cause_code' | 'cause_level';
}

/**
 * The groupings whose cells carry a code beside the label. An ICD chapter or sub-chapter cell
 * names its node of CDC's ICD-10 tree as `cd` (`C00-D48`) — the form `cause_icd10` takes, so a
 * row chains straight into a filter. A 113-cause-list cell gives its depth in that list as `h`
 * (1 for a top-level cause, up to 5): the list nests, and a deeper row is part of a cause one
 * level up. No other grouping sends either attribute, and the codes some labels quote
 * (`#Tuberculosis (A16-A19)`) stay label text.
 *
 * WONDER accepts chapter and sub-chapter grouped together, and both cells then carry a `cd`.
 * The row keeps the sub-chapter's: it is the finer node and lies inside exactly one chapter, so
 * the entry listed later wins when two feed the same key.
 */
export const WONDER_DIMENSION_CODES: readonly WonderDimensionCode[] = [
  { dimension: 'icd_chapter', attribute: 'cd', key: 'cause_code' },
  { dimension: 'icd_subchapter', attribute: 'cd', key: 'cause_code' },
  { dimension: 'cause_113', attribute: 'h', key: 'cause_level' },
];

/**
 * Most rows a query's grouping may be able to produce, counted as the product of the values each
 * grouping dimension can take (`groupingValueCounts`). WONDER's time to answer grows with the
 * table, and a table past this bound takes it longer than the 20-second request deadline, so a
 * grouping that could exceed it is refused before any request is spent. WONDER's own ceiling,
 * 75,000 rows, sits far past what it answers inside that deadline. The bound equals the most
 * rows one tool call returns, so every table a query is allowed to produce fits on one page.
 */
export const WONDER_MAX_TABLE_ROWS = 10_000;

/**
 * Distinct values of each cause grouping a final database can return: as its request form lists
 * them for the 113-cause list, the ICD chapters and the injury intents; fifteen leading causes by
 * definition; and for ICD sub-chapters, which the form's finder loads on demand, as many as CDC
 * returns with deaths over a database's whole span — 177 on D76, 176 on the provisional
 * database. A sub-chapter whose deaths CDC suppresses over every year is suppressed in every
 * finer stratum too, so it never reaches a table. The provisional database lists one value more
 * in the chapter and 113-cause lists — its withheld-cause row.
 */
const CAUSE_GROUPING_VALUES = {
  icd_chapter: 20,
  icd_subchapter: 177,
  cause_113: 137,
  leading_causes: 15,
  injury_intent: 6,
} as const;

/**
 * The finer level that enumerates a coarser one: a `month` cell is a year-month, and an ICD
 * sub-chapter lies inside exactly one chapter. Grouped beside its finer level, the coarser one
 * splits no row further.
 */
const FINER_LEVEL: Partial<Record<WonderGroupBy, WonderGroupBy>> = {
  year: 'month',
  icd_chapter: 'icd_subchapter',
};

/** How many rows one grouping dimension can multiply a query's table by. */
export interface WonderGroupingValues {
  dimension: WonderGroupBy;
  values: number;
  /**
   * The finer level grouped beside this dimension, which already enumerates its values — set
   * when `values` is 1 for that reason alone.
   */
  within?: WonderGroupBy;
}

/**
 * The most rows each `groupBy` dimension can multiply this query's table by, in `groupBy` order:
 * the distinct values it can take, or 1 when its finer level is grouped too (`year` beside
 * `month`, `icd_chapter` beside `icd_subchapter`), since that level already enumerates them.
 * Their product bounds the rows WONDER can return, so it can be checked against
 * `WONDER_MAX_TABLE_ROWS` before a request is sent. Filters narrow the dimensions they restrict
 * — a `yearRange` the years and months, `ageGroups` the age groups, a `sex` other than all the
 * sexes — and a cause filter narrows none, since how many causes of a grouping it covers is not
 * known before CDC answers. Every count is a ceiling: CDC hides strata with no deaths, so a
 * table usually holds fewer rows.
 */
export function groupingValueCounts(options: WonderQueryOptions): WonderGroupingValues[] {
  const spec = wonderDatabaseSpec(options.database);
  const years = options.yearRange
    ? options.yearRange.to - options.yearRange.from + 1
    : spec.lastYear - spec.firstYear + 1;
  const withheldRow = spec.lagWithheldCause ? 1 : 0;
  return options.groupBy.map((dimension) => {
    const finer = FINER_LEVEL[dimension];
    return finer && options.groupBy.includes(finer)
      ? { dimension, values: 1, within: finer }
      : { dimension, values: valueCount(dimension) };
  });

  function valueCount(dimension: WonderGroupBy): number {
    switch (dimension) {
      case 'year':
        return years;
      case 'month':
        return years * 12;
      case 'age_group':
        return options.ageGroups?.length || WONDER_AGE_GROUPS.length;
      case 'sex':
        return options.sex === 'male' || options.sex === 'female' ? 1 : 2;
      // Bridged race has four groups; the single-race forms list six categories and "Not Available".
      case 'race':
        return spec.raceVariable === 'V8' ? 4 : 7;
      case 'hispanic_origin':
        return 3;
      case 'icd_chapter':
      case 'cause_113':
        return CAUSE_GROUPING_VALUES[dimension] + withheldRow;
      case 'icd_subchapter':
      case 'leading_causes':
      case 'injury_intent':
        return CAUSE_GROUPING_VALUES[dimension];
    }
  }
}

/**
 * Measures returned per row, in fixed column order. Deaths, population, and crude rate are
 * always present; age-adjusted rate is added only when WONDER can standardize by age — it
 * is dropped when age is a grouping dimension (age cannot be both a grouping dimension and
 * the standardization axis) and when the age-group filter selects exactly one group.
 */
export const WONDER_MEASURES = ['deaths', 'population', 'crude_rate', 'age_adjusted_rate'] as const;
/** A measure key. */
export type WonderMeasure = (typeof WONDER_MEASURES)[number];

/**
 * Measures CDC publishes a 95% confidence interval for — both rates, once the request asks for
 * it on every database. The interval arrives as a child of the rate's own cell, and a row
 * carries it as two flat numeric keys right after the rate: `<rate>_lower` and `<rate>_upper`.
 */
export const WONDER_RATE_MEASURES = [
  'crude_rate',
  'age_adjusted_rate',
] as const satisfies readonly WonderMeasure[];

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
  /**
   * ICD-10 underlying-cause codes or ranges (e.g. `["X40-X49"]`, `["I21", "I22"]`), matched as a
   * union — one finder value each. Omit for all causes.
   */
  causeIcd10?: string[] | undefined;
  /** Database to query. Defaults to `underlying_1999_2020` (D76). */
  database?: WonderDatabase | undefined;
  /** Dimensions to group by, in output-column order. 1–4 entries. */
  groupBy: WonderGroupBy[];
  /**
   * ICD-10 codes or ranges to match against any cause listed on the death certificate, matched
   * as a union and ANDed with `causeIcd10`. Only meaningful on a database whose spec has
   * `multipleCause` — the callers reject it elsewhere.
   */
  mcdIcd10?: string[] | undefined;
  /** Sex filter. Defaults to all. */
  sex?: WonderSex | undefined;
  /** Inclusive year range within the selected database's span. Omit for all years. */
  yearRange?: WonderYearRange | undefined;
}

/**
 * One result row: dimension values (strings), then the codes a cause grouping's cells carry
 * (`cause_code`, `cause_level` — see `WONDER_DIMENSION_CODES`), then measure values keyed by
 * friendly names, each rate followed by its 95% confidence interval as `<rate>_lower` and
 * `<rate>_upper`. A measure cell WONDER returned as a status token rather than a number is null
 * here — the matching `WonderCellNote` says which token it was. A bound is null wherever CDC
 * sent no interval for its rate; nothing is computed locally.
 */
export type WonderRow = Record<string, string | number | null>;

/**
 * A measure cell WONDER returned as a status token instead of a number. WONDER writes
 * "Suppressed" (confidentiality — figures representing fewer than 10 persons), "Unreliable"
 * (a rate CDC judges statistically unstable by its database's `unreliableCriterion`, shown as
 * the token instead of the rate), or "Not Applicable" (no population denominator) in place of
 * the value. The cell reads null in `rows`, so this record is the only thing that distinguishes
 * those cases from each other and from a genuinely absent value.
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
 * Which rows a WONDER message says were withheld from the table. `zero_deaths` strata recorded
 * no deaths, so the deaths in `rows` are still complete without them; `suppressed_deaths`
 * strata had a death count CDC withheld for confidentiality, so they are not; `unspecified` is
 * a hidden-rows message naming neither, read the cautious way, as suppression.
 */
export type HiddenRowsKind = 'zero_deaths' | 'suppressed_deaths' | 'unspecified';

/**
 * The kind of rows a WONDER message reports withholding, or undefined when it reports none.
 * "Rows with zero Deaths are hidden." and "Rows with suppressed Deaths are hidden." are the two
 * every mortality database emits. A hidden row never reaches `rows` at all, so unlike a
 * suppressed *cell* nothing in the table marks its absence; the message is the only evidence it
 * existed.
 *
 * A sentence reports hidden rows when the word "rows" comes before the word "hidden" in it. Once
 * it does, the whole sentence is read: any mention of suppression in it makes the kind
 * `suppressed_deaths`, and otherwise it is `zero_deaths` only when the words between every such
 * "rows" and its "hidden" name zero deaths. A message with several such sentences takes the most
 * cautious kind among them: any suppression, then any unnamed kind, then zero deaths.
 */
export function hiddenRowsKind(message: string): HiddenRowsKind | undefined {
  let kind: HiddenRowsKind | undefined;
  for (const sentence of message.split('.')) {
    const named = hiddenRowsSpans(sentence);
    if (named.length === 0) continue;
    if (/\bsuppress/i.test(sentence)) return 'suppressed_deaths';
    kind =
      kind === 'unspecified' || named.some((words) => !/\bzero\b/i.test(words))
        ? 'unspecified'
        : 'zero_deaths';
  }
  return kind;
}

/**
 * The words between each "rows" in a sentence and the first "hidden" after it, left to right.
 * Each search resumes where the previous one stopped, so the walk is linear in the sentence —
 * never a pattern that retries from every "rows" it passes.
 */
function hiddenRowsSpans(sentence: string): string[] {
  const rows = /\brows\b/gi;
  const hidden = /\bhidden\b/gi;
  const spans: string[] = [];
  while (rows.exec(sentence)) {
    hidden.lastIndex = rows.lastIndex;
    const closer = hidden.exec(sentence);
    if (!closer) break;
    spans.push(sentence.slice(rows.lastIndex, closer.index));
    rows.lastIndex = hidden.lastIndex;
  }
  return spans;
}

/** Result of a WONDER query. */
export interface WonderResult {
  /** CDC-provided caveats and footnotes for this result set. */
  caveats: string[];
  /** Measure cells WONDER returned as a status token instead of a number. */
  cellNotes: WonderCellNote[];
  /**
   * Ordered keys of the cells each row is read from: dimensions then measures. Rows carry more
   * keys than these — a cause grouping's codes follow the dimensions, and each rate's interval
   * bounds follow it.
   */
  columns: string[];
  /** Database identifier the data came from (e.g. "D76"). */
  database: string;
  /** WONDER's own title for that database, so a result names its source without a lookup. */
  databaseTitle: string;
  /**
   * The last date of death the table holds, as `YYYY-MM-DD` — read from the provisional
   * database's response, whose latest year runs only to it. Absent on the final databases, which
   * name a finished year instead of a date, and on a provisional response that names none.
   */
  dataThrough?: string;
  /**
   * Informational messages WONDER returned with the table. Present when the row set was
   * filtered before it was sent (rows with zero or suppressed deaths are hidden by default);
   * empty when nothing was withheld.
   */
  messages: string[];
  /** Number of rows returned. */
  rowCount: number;
  /**
   * Result rows. Keys are the requested group-by dimensions, then a cause grouping's codes, then
   * the measures, each rate followed by its interval bounds.
   */
  rows: WonderRow[];
  /** How many of `cellNotes` carry the "Suppressed" token. */
  suppressedCount: number;
}
