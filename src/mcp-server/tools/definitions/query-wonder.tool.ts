/**
 * @fileoverview Tool to query CDC WONDER national mortality statistics across its five
 * mortality databases — final and provisional, underlying-cause and multiple-cause.
 * @module mcp-server/tools/definitions/query-wonder
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  groupingValueCounts,
  hiddenRowsKind,
  isSuppressedToken,
  reachesLagWithheldCause,
  WONDER_AGE_GROUPS,
  WONDER_CAUSE_GROUPINGS,
  WONDER_DATABASE_SPECS,
  WONDER_DATABASES,
  WONDER_GROUP_BY,
  WONDER_LAG_WINDOW_DAYS,
  WONDER_LAG_WITHHELD_CAUSE,
  WONDER_LAG_WITHHELD_SUBCHAPTER_CODE,
  WONDER_MAX_TABLE_ROWS,
  WONDER_YEAR_BOUNDS,
  type WonderCellNote,
  type WonderDatabaseSpec,
  type WonderGroupBy,
  type WonderQueryOptions,
  type WonderResult,
  type WonderRow,
  wonderDatabaseSpec,
  wonderDatabaseSpecById,
} from '@/services/wonder/types.js';
import { getWonderService } from '@/services/wonder/wonder-service.js';
import { escapeTableCell, markdownCodeSpan } from '@/utils/markdown.js';

/**
 * An ICD-10 code or range, e.g. "I21", "X40-X49", "V01-Y89". Shared by cause_icd10 and
 * mcd_icd10, whose descriptions say they take the same form — one pattern keeps that true. The
 * pattern checks spelling only: WONDER accepts a range only when it is a node of its own ICD-10
 * tree (a chapter or a block), and rejects any other span as an invalid code.
 */
const ICD10_CODE_OR_RANGE = /^[A-Z][0-9]{2}(\.[0-9]+)?(-[A-Z][0-9]{2}(\.[0-9]+)?)?$/;

/**
 * Most entries one cause list may carry. WONDER publishes no cap on finder values; the longest
 * list verified upstream is the 16-code overdose definition. Fifty holds any of CDC's standard
 * code-set definitions spelled out code by code — the firearm set is 13 — while a block or
 * chapter covers anything wider in one entry.
 */
const MAX_ICD10_CODES = 50;

/**
 * One cause filter: `''` (every cause), the withheld-cause marker in either the chapter or the
 * sub-chapter form a cause row carries, an ICD-10 code or tree-node range, or a list of the last
 * two matched as a union. An empty list filters nothing, so it reads as omitted, as
 * `age_groups: []` does; a `''` inside a list stays rejected, since "every cause" beside a code
 * has no single reading. The single-value branches sit flat in the top-level union — a nested
 * union emits an `anyOf` branch with no `type`, which some clients reject.
 */
const icd10Filter = (codeDescription: string) => {
  const code = z.string().regex(ICD10_CODE_OR_RANGE).describe(codeDescription);
  const marker = z.literal([WONDER_LAG_WITHHELD_CAUSE, WONDER_LAG_WITHHELD_SUBCHAPTER_CODE]);
  return z.union([
    z.literal(''),
    marker,
    code,
    z
      .array(
        z
          .union([marker, code])
          .describe('One list entry: an ICD-10 code or range, or the withheld-cause marker.'),
      )
      .max(MAX_ICD10_CODES)
      .describe(
        `A list of up to ${MAX_ICD10_CODES} entries, each in the single-value form, matched as a union: a death counts once when it matches any of them, so a code set such as X40–X44 plus X60–X64 is one series with one set of rates. Repeated entries are ignored. An empty list reads as omitted.`,
      ),
  ]);
};

/**
 * Normalize a cause filter to a deduplicated list; empty when the filter is absent, `''`, or
 * `[]`. The withheld-cause marker's sub-chapter form becomes the chapter form, the only one
 * WONDER is known to accept as a finder value.
 */
function causeCodes(value: string | string[] | undefined): string[] {
  if (value === undefined || value === '') return [];
  const codes = (Array.isArray(value) ? value : [value]).map((code) =>
    code === WONDER_LAG_WITHHELD_SUBCHAPTER_CODE ? WONDER_LAG_WITHHELD_CAUSE : code,
  );
  return [...new Set(codes)];
}

/**
 * Ceiling on `offset`. The handler refuses a grouping that could produce more than
 * `WONDER_MAX_TABLE_ROWS` rows, so every row of every table it accepts sits at an offset below
 * this, whatever page size walks it.
 */
const MAX_OFFSET = WONDER_MAX_TABLE_ROWS;
/**
 * Most rows one call returns. `limit` takes any positive integer and is lowered to this in the
 * handler rather than rejected; an omitted `limit` reads as the rest of the table up to it.
 * WONDER's request carries no limit of its own, so every call re-runs the whole query behind
 * the 16-second gap and repeats the caveats and messages: a small default would multiply both,
 * so the ceiling matches `WONDER_MAX_TABLE_ROWS` and any table a query may produce fits in one
 * call.
 */
const MAX_ROWS_PER_CALL = 10_000;

/**
 * A row count as the notices print it (`2,014`). Values a caller passes back — `offset=N`,
 * `limit=N` — stay bare, in the form the input takes.
 */
const count = (n: number) => n.toLocaleString('en-US');

type CellTokens = ReadonlyMap<string, string>;

/** Status tokens by row index, then by column — the lookup `format()` paints cells from. */
function tokensByRow(cellNotes: readonly WonderCellNote[]): Map<number, Map<string, string>> {
  const byRow = new Map<number, Map<string, string>>();
  for (const note of cellNotes) {
    const cells = byRow.get(note.row) ?? new Map<string, string>();
    cells.set(note.column, note.token);
    byRow.set(note.row, cells);
  }
  return byRow;
}

/**
 * One table line, as `format()` renders it: a cell CDC replaced with a status token shows the
 * token rather than the null it reads as in `rows`, so a `content[]`-only client can tell it
 * apart from a blank.
 */
function renderTableRow(row: WonderRow, columns: readonly string[], tokens?: CellTokens): string {
  const cells = columns.map((column) => {
    const value = tokens?.get(column) ?? row[column];
    return escapeTableCell(value == null ? '' : String(value));
  });
  return `| ${cells.join(' | ')} |`;
}

/** The table's heading and separator lines over `columns`. */
function renderTableHeader(columns: readonly string[]): string[] {
  return [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
}

/**
 * Which databases apply which Unreliable rule, as the tool and token descriptions state them —
 * "D76 and D77 when it is computed from 20 or fewer deaths, and D176, D158, and D157 when …" —
 * read off `WONDER_DATABASE_SPECS` so the text cannot drift from the specs.
 */
function unreliableRules(): string {
  const byCriterion = new Map<string, string[]>();
  for (const database of WONDER_DATABASES) {
    const { id, unreliableCriterion } = WONDER_DATABASE_SPECS[database];
    byCriterion.set(unreliableCriterion, [...(byCriterion.get(unreliableCriterion) ?? []), id]);
  }
  const list = new Intl.ListFormat('en', { type: 'conjunction' });
  return [...byCriterion]
    .map(([criterion, ids]) => `${list.format(ids)} when ${criterion}`)
    .join(', and ');
}

/**
 * What a non-suppression CDC status token means on the database that returned it, keyed by the
 * lowercased token; undefined for a token CDC does not document. Suppression is reported through
 * its own count and wording, so it is not listed here. An Unreliable rate is not shown at all —
 * the token stands where it would be — and the rule CDC judged it by depends on the database.
 */
function tokenMeaning(token: string, database: WonderDatabaseSpec | undefined): string | undefined {
  switch (token.toLowerCase()) {
    case 'unreliable':
      return `no rate shown — CDC flags the rate as statistically unstable and puts the token in its place${database ? ` (on ${database.id}, when ${database.unreliableCriterion})` : ''}, while the row's deaths and population stand`;
    case 'not applicable':
      return 'not computable — the population denominator is unavailable';
  }
  return;
}

/** `: <meaning>` suffix for a token CDC documents; empty for one it does not. */
function gloss(token: string, database: WonderDatabaseSpec | undefined): string {
  const meaning = tokenMeaning(token, database);
  return meaning ? `: ${meaning}` : '';
}

/**
 * Render one cell note as ``row 3, `crude_rate` — `Unreliable`: <meaning>``. The token is
 * CDC's own text, so its span is sized to hold any backtick in it.
 */
function describeCellNote(note: WonderCellNote, database: WonderDatabaseSpec | undefined): string {
  return `row ${note.row}, \`${note.column}\` — ${markdownCodeSpan(note.token)}${gloss(note.token, database)}`;
}

/** A UTC calendar day as the notices print it — `October 17, 2026`. */
function longDate(day: Date): string {
  return day.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** What the provisional database's reporting lag means for one query. */
interface ProvisionalLagInput {
  /** The `group_by` entries that partition deaths by underlying cause (`WONDER_CAUSE_GROUPINGS`). */
  causeGroupings: readonly WonderGroupBy[];
  /** Normalized `cause_icd10` entries. */
  causes: readonly string[];
  /** The last date of death the response holds (`YYYY-MM-DD`), when it names one. */
  dataThrough: string | undefined;
  /** The database's last year — the current year, standing in for an unnamed data-through date. */
  lastYear: number;
  /** Normalized `mcd_icd10` entries. */
  mcdCauses: readonly string[];
  /** True when `group_by` holds `month`. */
  monthGrouped: boolean;
  /** The years the query asked for: `year_range`, or every year the database holds. */
  years: { from: number; to: number };
}

/**
 * The provisional database's two reporting-lag clauses for one query. Both key on the years the
 * query asked for, never on the rows returned or their `(provisional and partial)` label, which
 * only a year grouping shows — a `["sex"]` grouping sums the partial year with no label in sight.
 *
 * - Partial year: the years include the data-through year, whose deaths run only to that date
 *   while its population is the full-year estimate. Grouped by month, the month that date falls
 *   in is partial too, and its row carries the same `(provisional and partial)` label as the
 *   full months before it, so the clause names it — unless the date is the month's last day.
 * - Withheld causes: a cause filter reaches a cause CDC withholds for the 24 weeks before the
 *   data-through date, or the rows are grouped by underlying cause with no underlying-cause
 *   filter keeping them clear of one — and the years reach that window. The window is checked on
 *   its own: a data-through date in January opens it in the year before, which is already
 *   finished. A cause grouping moves the withheld deaths out of their own cause's row (into a
 *   withheld-cause row of their own by chapter or sub-chapter), so those rows run low as a
 *   filtered count does.
 *
 * A response that names no data-through date still gets both, keyed on the database's last
 * year and worded without dates. With neither a cause filter nor a cause grouping there is no
 * withheld-cause clause: CDC counts the withheld deaths in all-cause totals.
 */
function provisionalLagNotices({
  causeGroupings,
  causes,
  dataThrough,
  lastYear,
  mcdCauses,
  monthGrouped,
  years,
}: ProvisionalLagInput): string[] {
  const through = dataThrough ? new Date(`${dataThrough}T00:00:00Z`) : undefined;
  const cutoff = through && new Date(through.getTime() - WONDER_LAG_WINDOW_DAYS * 86_400_000);
  const throughYear = through?.getUTCFullYear() ?? lastYear;
  const cutoffYear = cutoff?.getUTCFullYear() ?? throughYear;
  const notices: string[] = [];

  if (years.from <= throughYear && throughYear <= years.to) {
    const endsMonth =
      through && new Date(through.getTime() + 86_400_000).getUTCMonth() !== through.getUTCMonth();
    const partialMonth =
      monthGrouped && through && !endsMonth
        ? ` ${through.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long' })}, the month that date falls in, is itself partial, so its deaths read low beside a full month's.`
        : '';
    notices.push(
      `The provisional database holds ${throughYear}${through ? '' : ', the current year,'} only through ${through ? longDate(through) : 'its latest weekly update'}: deaths for ${throughYear} cover part of the year while its population is the full-year estimate, so counts and rates that include ${throughYear} read low, and neither compares with a finished year's.${partialMonth}`,
    );
  }

  const filterReaches =
    reachesLagWithheldCause(causes, 'underlying') || reachesLagWithheldCause(mcdCauses, 'multiple');
  const groupingReaches =
    causeGroupings.length > 0 &&
    (causes.length === 0 || reachesLagWithheldCause(causes, 'underlying'));
  if ((filterReaches || groupingReaches) && years.to >= cutoffYear && years.from <= throughYear) {
    const window =
      through && cutoff
        ? `after ${longDate(cutoff)} — the 24 weeks before ${longDate(through)} —`
        : 'in the 24 weeks before the provisional data ends,';
    const period = cutoff ? `any period after ${longDate(cutoff)}` : 'those weeks';
    const shortfall = filterReaches
      ? `the cause filter here misses them and its counts and rates for ${period} run low`
      : `the ${causeGroupings.join(' and ')} rows for those causes miss them and their counts and rates for ${period} run low — the withheld deaths fill a row of their own by ICD chapter or sub-chapter, and a ranking across causes places those causes lower than their full count would`;
    notices.push(
      `CDC withholds the cause of external-cause (V01-Y89), sudden-death (R95, R96) and drug-poisoning (T36-T50) deaths ${window} counting them under "${WONDER_LAG_WITHHELD_CAUSE}" until their cause is released, so ${shortfall}. Query cause_icd10 "${WONDER_LAG_WITHHELD_CAUSE}" on this database for the count withheld across all three: it spans every withheld cause at once, so it bounds what any one filter or cause row is missing and is never added to that filter's or row's count.`,
    );
  }
  return notices;
}

/**
 * Tally the status tokens other than "Suppressed" (which has its own count field) by token
 * text, in first-seen order, as `Unreliable (2 cells): <meaning>` phrases.
 */
function tallyOtherTokens(cellNotes: WonderCellNote[], database: WonderDatabaseSpec): string[] {
  const counts = new Map<string, number>();
  for (const note of cellNotes) {
    if (isSuppressedToken(note.token)) continue;
    counts.set(note.token, (counts.get(note.token) ?? 0) + 1);
  }
  return [...counts].map(
    ([token, n]) => `${token} (${n} cell${n === 1 ? '' : 's'})${gloss(token, database)}`,
  );
}

export const queryWonder = tool('cdc_query_wonder', {
  description: `Query CDC WONDER for national US mortality statistics — deaths, population, and crude/age-adjusted death rates — across its five mortality databases, selected with the database input: final underlying-cause data for 1999–2020 (the default) or 2018–2024, provisional data running from 2018 through the current year (its latest year partial, with a notice saying so), and two multiple-cause databases covering the same two eras. Break results out by year, month, age group, sex, race, Hispanic origin, or underlying cause of death — ICD-10 chapter or sub-chapter, CDC's 113-cause list, its 15 leading causes, or injury intent — and filter by ICD-10 cause of death, sex, age group, or year range; on a multiple-cause database, mcd_icd10 additionally matches a cause listed anywhere on the death certificate rather than only the one certified as underlying. Each database holds a different span of years (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last} across all of them) and a request whose year_range falls outside the selected one's span is rejected with that span named. WONDER is a separate CDC system from the Socrata datasets the other cdc_* tools query. Data is national only — sub-national (state/county) breakdowns are not available through the API (CDC vital-statistics policy). Chapter and sub-chapter rows carry their ICD-10 code range as cause_code, which cause_icd10 accepts as it stands; 113-cause-list rows carry cause_level, their depth in that nested list, whose deeper causes are already counted in the cause containing them; leading_causes ranks the 15 leading causes by deaths and combines with no other grouping, while the filters still apply; month rows carry deaths only — CDC publishes no monthly population, so population and both rates come back "Not Applicable". The values each grouping dimension can take multiply to bound the table — year beside month, or icd_chapter beside icd_subchapter, adds nothing, since the finer level already enumerates the coarser — and a grouping that could produce more than ${count(WONDER_MAX_TABLE_ROWS)} rows is refused before any request with the product named, since WONDER takes longer than the request deadline to answer a table that large; narrow year_range, sex or age_groups, or drop a dimension. Some measure cells come back as a CDC status token rather than a number — "Suppressed" (withheld for confidentiality), "Unreliable" (a rate CDC judges statistically unstable and does not show — on ${unreliableRules()}), or "Not Applicable" (no population denominator); those cells read null in rows and each one is listed in cellNotes with its token. Each rate comes with the 95% confidence interval CDC publishes for it, as <rate>_lower and <rate>_upper right after the rate — null where CDC published none — so two rates can be compared by their intervals rather than their point values. CDC also drops whole rows before sending the table — strata with zero deaths, and strata whose death count is suppressed — so a stratum can be missing from rows entirely; messages carries CDC's statement whenever that happened. One call returns at most ${count(MAX_ROWS_PER_CALL)} rows: with limit omitted it returns the rest of the table up to that ceiling, a larger limit is lowered to it, and a smaller limit takes smaller pages; a page that stops short of the end reports the table's totalCount and a nextOffset to continue from. Paging shapes the response only — every call fetches the whole table from WONDER and returns a slice of it, so the figures, caveats and hidden-row notices are the same on every page and a smaller page saves no time. CDC rejects requests made less than 15 seconds apart across all five databases, so calls are spaced automatically: calls made while another is running wait their turn and run one after another, each queued call adding about 16 seconds plus its own query time before it returns. A request WONDER has not finished answering within 20 seconds fails as a retryable upstream_error, so one call queued behind another returns within about 56 seconds.`,
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: `The request contradicts itself — a year_range whose from is later than its to, or a group_by dimension listed twice — or asks for a combination CDC refuses — age_groups holding "NS" beside only some of the known age groups, or leading_causes beside another group_by value — or groups by dimensions whose values could make a table of more than ${count(WONDER_MAX_TABLE_ROWS)} rows, or does not fit the selected database — a year_range outside the years it holds, mcd_icd10 against a database that records only the underlying cause, or the withheld-cause marker against one that keeps no withheld backlog — or WONDER itself rejected it, e.g. an ICD-10 code or range its tree does not hold, or a filter/grouping combination it does not allow.`,
      recovery:
        'Read the returned message: it names the input at fault, the span the selected database holds, the databases that accept mcd_icd10 or the withheld-cause marker, the row count a grouping could reach, or the part WONDER rejected. Fix year_range, group_by, or age_groups, narrow the grouping or its filters, switch database, drop the filter, or correct the ICD-10 code, then retry.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'A request reached WONDER less than 15 seconds after the previous response to the same source IP finished, and WONDER returned 429. This server queues its own calls, so the earlier request usually came from another client sharing that IP.',
      retryable: true,
      recovery:
        'Wait at least 16 seconds after the previous response completes, then retry the same query. Parallel retries do not go out together — concurrent calls wait their turn and run one at a time, each queued call adding about 16 seconds.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'WONDER returned an unexpected response, was unreachable, or did not finish answering a request within 20 seconds.',
      retryable: true,
      recovery: 'Retry after a brief delay; wonder.cdc.gov may be temporarily unavailable.',
    },
  ],

  input: z.object({
    database: z
      .enum(WONDER_DATABASES)
      .default('underlying_1999_2020')
      .describe(
        'Which WONDER mortality database to query. "underlying_1999_2020" (D76) is final data for 1999–2020 and the default. "provisional" (D176) runs 2018 through the current year, updated weekly, and returns the most recent years labelled e.g. "2025 (provisional)". Its latest year is partial — deaths only through the data-through date the response names, against a full-year population — so its counts and rates read low next to a finished year, and a notice says so whenever the years queried include it. "underlying_2018_2024" (D158) is settled — not provisional — data for 2018–2024. "multiple_1999_2020" (D77) and "multiple_2018_2024" (D157) record every cause listed on the death certificate; without an mcd_icd10 filter they return the same figures as the underlying-cause database for the same era, so pick one only to use that filter. The two 1999–2020 databases report race in CDC\'s four bridged groups; the other three use the six single-race groups — figures broken out by race are not comparable between the two families.',
      ),
    group_by: z
      .array(z.enum(WONDER_GROUP_BY))
      .min(1)
      .max(4)
      .default(['year'])
      .describe(
        `Dimensions to break results out by (1–4, each at most once), in output-column order — e.g. ["year"], ["year","sex"], ["icd_chapter","year"]. Results are always national. "race" resolves to whichever race vocabulary the selected database uses — four bridged groups (Asian and Pacific Islander combined) on the 1999–2020 databases, six single-race categories on the others, one of them "More than one race" — so a race series from one family cannot be spliced onto one from the other. "hispanic_origin" splits Hispanic or Latino, Not Hispanic or Latino, and Not Stated. "month" groups by calendar month (labels such as "Jan., 2019") and returns deaths only: population and both rates are "Not Applicable". The rest group by underlying cause: "icd_chapter" and "icd_subchapter" by node of CDC's ICD-10 tree, each row carrying the node's code range as cause_code (e.g. "C00-D48"), which cause_icd10 takes as it stands; "cause_113" by CDC's 113-cause list, each row carrying cause_level, its depth in that nested list (1 for a top-level cause) — a deeper cause is already counted in the one containing it; "leading_causes" by the 15 leading causes, ranked by deaths, and only on its own — CDC refuses it beside any other dimension, though the filters still apply; "injury_intent" by intent (unintentional, suicide, homicide, undetermined, legal intervention, or no injury). The most values the listed dimensions can take, multiplied, must be ${count(WONDER_MAX_TABLE_ROWS)} or fewer — e.g. icd_subchapter (177) × year (22 on the 1999–2020 databases) × sex (2) fits, and adding age_group (12) does not — or the call is refused before any request. year beside month, and icd_chapter beside icd_subchapter, add nothing to the product, since each month names its year and each sub-chapter sits inside one chapter.`,
      ),
    cause_icd10: icd10Filter(
      'ICD-10 underlying-cause code or range. WONDER takes a node of its ICD-10 tree — a chapter such as "A00-B99" (infectious) or "V01-Y89" (external causes), a block such as "X40-X49" (accidental poisoning) or "C00-C97" (malignant neoplasms), or a single code such as "I21" — and rejects any other span, e.g. "X40-X44", naming it in the error. List the codes (or blocks) to cover a span that is not a tree node.',
    )
      .optional()
      .describe(
        `Filter to ICD-10 underlying causes of death — the single condition CDC certified as having started the chain of events leading to death. Takes one code or range, or a list of them for a cause defined as a code set, e.g. drug overdose as ["X40","X41","X42","X43","X44","X60","X61","X62","X63","X64","X85","Y10","Y11","Y12","Y13","Y14"]. Omit for all causes. Accepted by every database. "${WONDER_LAG_WITHHELD_CAUSE}" is not an ICD-10 code but CDC's own marker for deaths whose cause it is still withholding under the provisional database's six-month reporting lag; it counts that backlog, and only the "provisional" database offers it. "${WONDER_LAG_WITHHELD_SUBCHAPTER_CODE}", the cause_code a sub-chapter row carries for the same deaths, is accepted too and sent as "${WONDER_LAG_WITHHELD_CAUSE}". On that database CDC withholds external-cause (V01-Y89) and sudden-death (R95, R96) causes for the 24 weeks before its data-through date, so a filter reaching them — a block or chapter containing one included — undercounts those weeks; the notice names the cutoff.`,
      ),
    mcd_icd10: icd10Filter(
      'ICD-10 code or range, same form as cause_icd10 — a chapter such as "S00-T98" (injury and poisoning, a chapter the underlying-cause finder does not list), a block such as "J09-J18" (influenza and pneumonia), or a single code such as "T40.1" (heroin).',
    )
      .optional()
      .describe(
        `Filter to deaths with any of these ICD-10 codes recorded anywhere on the death certificate, whether or not it was the underlying cause — e.g. "died with a respiratory condition listed", a population no underlying-cause query can produce. Takes one code or range, or a list of them, e.g. opioid involvement as ["T40.0","T40.1","T40.2","T40.3","T40.4","T40.6"]. Valid only when database is "multiple_1999_2020", "multiple_2018_2024", or "provisional"; the other databases record only the underlying cause and reject it. "${WONDER_LAG_WITHHELD_CAUSE}", the withheld-cause marker described under cause_icd10, is offered here too but only by "provisional", where the 24-week withholding also covers drug poisoning (T36-T50) as a listed cause. Combines with cause_icd10, which keeps meaning the underlying cause: a death must match both filters. Omit for all causes.`,
      ),
    sex: z.enum(['all', 'male', 'female']).default('all').describe('Filter by sex.'),
    age_groups: z
      .array(z.enum(WONDER_AGE_GROUPS))
      .optional()
      .describe(
        'Restrict to deaths in any of the listed age groups — e.g. ["25-34","35-44"] covers both; a repeated group counts once. "1" is the under-1-year group. "NS" is the group CDC puts a death in when the age was not recorded; it is not covered by any of the ten-year groups, so a filter listing all eleven of those still leaves those deaths out and returns fewer deaths than the same query unfiltered. CDC refuses "NS" beside only some of the other groups: list it on its own to count those deaths, or list all twelve values — the same as omitting age_groups — to include them. Omit for all ages, which includes them.',
      ),
    year_range: z
      .object({
        from: z
          .number()
          .int()
          .min(WONDER_YEAR_BOUNDS.first)
          .max(WONDER_YEAR_BOUNDS.last)
          .describe(
            `First year (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last} across all databases; the selected one holds a narrower span).`,
          ),
        to: z
          .number()
          .int()
          .min(WONDER_YEAR_BOUNDS.first)
          .max(WONDER_YEAR_BOUNDS.last)
          .describe(
            `Last year (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last} across all databases; the selected one holds a narrower span).`,
          ),
      })
      .optional()
      .describe(
        `Inclusive year range; from must not be later than to. These bounds span every database (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last}); the years the selected one actually holds are narrower, and a range outside them is rejected with that database's span named. Omit for all years the database holds.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Rows to return from the table CDC sent — any positive integer. Omit to take the rest of the table from offset, up to ${count(MAX_ROWS_PER_CALL)} rows. One call returns at most ${count(MAX_ROWS_PER_CALL)} rows: a larger limit is lowered to ${count(MAX_ROWS_PER_CALL)}, and the response says so and gives a nextOffset when rows remain. WONDER's request carries no limit of its own, so this pages a table already fetched in full rather than narrowing the query: the deaths, rates, caveats and hidden-row notices are the same whichever page is read.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(MAX_OFFSET)
      .default(0)
      .describe(
        `Index of the first row to return, for continuing past a previous call (default 0, max ${MAX_OFFSET.toLocaleString('en-US')}). Rows keep the order CDC returned them in, which is stable for a given query, so offset plus limit walks the table without gaps or repeats. An offset at or past the row total returns an empty page rather than an error.`,
      ),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
      .describe(
        `Result rows. Each carries the requested group-by dimensions, then cause_code when grouped by icd_chapter or icd_subchapter — CDC's code range for the row's ICD-10 node (the sub-chapter's when both are grouped), null where CDC sent none; the provisional database's withheld-cause row reads "${WONDER_LAG_WITHHELD_CAUSE}" by chapter and "${WONDER_LAG_WITHHELD_SUBCHAPTER_CODE}" by sub-chapter, and cause_icd10 takes either as it stands — then cause_level when grouped by cause_113, the row's depth in that nested list as an integer, then deaths, population, crude_rate, and age_adjusted_rate (per 100,000) when age standardization is possible — it is omitted when age_group is a grouping dimension or age_groups selects a single group, and it is the rate to compare across groups, since crude_rate moves with each group's age mix. Each rate is followed by its 95% confidence interval: crude_rate_lower and crude_rate_upper, then age_adjusted_rate_lower and age_adjusted_rate_upper when the row has age_adjusted_rate. The bounds are CDC's own published figures, never computed here, and are null wherever CDC sent no interval (a "Not Applicable" rate, for one); an "Unreliable" rate reads null but keeps the interval CDC published with it. Dimension values are CDC's own labels with only surrounding whitespace removed, so the same year keys identically across databases; nothing inside a label is changed, and on the provisional database a year reads "2025 (provisional)" or "2026 (provisional and partial)" rather than a bare year. A measure cell CDC returned as a status token instead of a number is null here; cellNotes names the cell and the token. These are one page of the table CDC sent, in its order, bounded by limit and by the ${count(MAX_ROWS_PER_CALL)}-row per-call ceiling; totalCount says how many rows the whole table holds.`,
      ),
    rowCount: z
      .number()
      .describe(
        'Number of rows returned in this response — the page size whenever it falls short of totalCount.',
      ),
    database: z
      .string()
      .describe('WONDER dataset code the rows came from — e.g. "D76", "D176", "D157".'),
    databaseTitle: z
      .string()
      .describe(
        'CDC\'s own title for that database, e.g. "Underlying Cause of Death, 1999-2020". Names the era and record type the rows describe, so a result read on its own is self-describing.',
      ),
    caveats: z
      .array(z.string())
      .describe(
        'CDC-provided caveats and footnotes: data revisions, population-estimate sources, suppression and rate-reliability rules. CDC\'s links to its methodology pages are kept as Markdown links, e.g. "[More information.](https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Confidence-Intervals)". They describe the whole table CDC assembled, so they come back complete on every page rather than scoped to the rows returned.',
      ),
    cellNotes: z
      .array(
        z
          .object({
            row: z
              .number()
              .describe(
                'Zero-based index into rows — the rows in this response, so it is relative to the page rather than to the whole table.',
              ),
            column: z.string().describe('Measure column whose numeric value the token replaced.'),
            token: z
              .string()
              .describe(
                `Token CDC returned in place of a number: "Suppressed" (withheld for confidentiality, fewer than 10 persons), "Unreliable" (a rate CDC judges statistically unstable and replaces with this token — on ${unreliableRules()}; the row's deaths and population stand), or "Not Applicable" (no population denominator).`,
              ),
          })
          .describe('One flagged measure cell: where it is and what CDC put there.'),
      )
      .describe(
        'One entry per measure cell CDC returned as a status token rather than a number, covering the rows in this response only. Those cells read null in rows, so this is what tells a withheld value apart from an unreliable one or a genuinely absent one.',
      ),
    messages: z
      .array(z.string())
      .describe(
        'Notices CDC attached to this table, verbatim apart from links, which are kept as Markdown links. The ones that matter say rows were withheld before the table was sent — "Rows with zero Deaths are hidden." and "Rows with suppressed Deaths are hidden." A withheld row is absent from rows entirely, with nothing in the table marking the gap. A stratum hidden for zero deaths recorded none, so deaths summed from rows stay complete; while the suppressed-deaths message is present, a stratum missing from rows may have been dropped rather than unobserved, and any count, ranking, or completeness claim drawn from rows is partial. The notice says which reading applies. These describe the whole table, so they come back complete on every page. Empty when CDC withheld no rows.',
      ),
    suppressedCount: z
      .number()
      .describe(
        'How many cellNotes carry the "Suppressed" token — cells CDC withheld for confidentiality. Counted over the rows in this response, so it tracks the page rather than the whole table.',
      ),
  }),

  // Agent-facing result context: a summary of the grouping and filters applied (for
  // reproducibility), where the returned rows sit in the whole table, and a notice when
  // nothing matched or CDC replaced values with a token. Reaches structuredContent AND
  // content[] automatically — no format() entry.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Human-readable summary of the grouping and filters sent to WONDER.'),
    totalCount: z
      .number()
      .describe(
        'Rows in the whole table CDC returned, before any page was taken. Exact rather than estimated — the table is parsed in full before a page is taken from it.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows remain past the ones returned. Absent means this response runs to the end of the table, which is also the case for an offset past it.',
      ),
    shown: z.number().optional().describe('Number of rows returned in this response.'),
    cap: z
      .number()
      .optional()
      .describe(
        `Page size that ended this response — limit, or ${count(MAX_ROWS_PER_CALL)} (the most one call returns) when limit was omitted or set higher. Present only when rows remain past the page.`,
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to resume immediately after the last row returned. Present only when further rows remain.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance when no rows matched or CDC recorded no deaths for the query, when the returned rows are a page of a larger table — naming whether limit or the ${count(MAX_ROWS_PER_CALL)}-row per-call ceiling ended it — or the offset ran past it, whether the rows CDC withheld leave the deaths in rows complete or partial, a note when CDC returned a status token in place of a measure value, that rows grouped by cause_113 nest and do not sum across levels, on a multiple-cause database queried without mcd_icd10, that its figures match the underlying-cause database for the same years, and on the provisional database, when the years queried include its partial latest year (naming the partial month too when grouped by month) or a cause filter or cause grouping reaches causes CDC is still withholding under its 24-week reporting lag.`,
      ),
  },

  async handler(input, ctx) {
    const spec = wonderDatabaseSpec(input.database);

    /**
     * Normalized once, before anything reads them: the checks below, the service options (and
     * through them `measuresFor` and the request builder), and `effectiveQuery`. The cause lists
     * and age groups are unions, so dropping a repeat loses nothing — and a repeated age group
     * would otherwise read as two, keeping an age-adjusted rate that one group cannot support.
     */
    const causes = causeCodes(input.cause_icd10);
    const mcdCauses = causeCodes(input.mcd_icd10);
    const ageGroups = input.age_groups && [...new Set(input.age_groups)];

    /**
     * Every relational check lives here rather than in a Zod refinement, and each settles before
     * any WONDER request is spent. A refinement adds nothing to the emitted JSON Schema, so a
     * client never sees the constraint, and it fails argument parsing as `invalid_arguments`
     * before the handler runs — out of reach of the declared reason and its recovery.
     */
    const repeated = input.group_by.find((dim, i) => input.group_by.indexOf(dim) !== i);
    if (repeated) {
      throw ctx.fail(
        'invalid_query',
        `group_by lists "${repeated}" more than once; each dimension can appear only once. Remove the repeat from group_by.`,
      );
    }
    // WONDER answers this with HTTP 500 ("The 15 Leading Causes lists can't be combined with any
    // other Group By variables."); caught here so the refusal costs no request.
    if (input.group_by.includes('leading_causes') && input.group_by.length > 1) {
      throw ctx.fail(
        'invalid_query',
        `group_by pairs leading_causes with ${input.group_by.filter((dim) => dim !== 'leading_causes').join(', ')}, and CDC WONDER ranks the 15 leading causes only on their own: it refuses any other grouping beside them. Group by leading_causes alone — the filters still apply — or group by cause_113, whose list holds the same rankable causes (marked "#") and combines with other dimensions.`,
      );
    }
    if (input.year_range && input.year_range.from > input.year_range.to) {
      throw ctx.fail(
        'invalid_query',
        `year_range runs backwards: from ${input.year_range.from} is later than to ${input.year_range.to}. Swap them so from is the earlier year.`,
      );
    }
    if (
      input.year_range &&
      (input.year_range.from < spec.firstYear || input.year_range.to > spec.lastYear)
    ) {
      throw ctx.fail(
        'invalid_query',
        `${spec.id} (${spec.title}) holds ${spec.firstYear}–${spec.lastYear}; year_range ${input.year_range.from}–${input.year_range.to} falls outside it. Narrow the range or select a database whose span covers those years.`,
      );
    }
    if (
      ageGroups?.includes('NS') &&
      ageGroups.length > 1 &&
      ageGroups.length < WONDER_AGE_GROUPS.length
    ) {
      throw ctx.fail(
        'invalid_query',
        'age_groups combines "NS" (age not stated) with only some of the known age groups, which CDC WONDER refuses. List "NS" on its own to count deaths with no recorded age, drop "NS" to keep the listed groups, or omit age_groups for all ages, deaths with no recorded age included.',
      );
    }
    if (mcdCauses.length > 0 && !spec.multipleCause) {
      throw ctx.fail(
        'invalid_query',
        `mcd_icd10 needs a database that records every cause on the death certificate. ${spec.id} (${spec.title}) records only the underlying cause. Use database "multiple_1999_2020", "multiple_2018_2024", or "provisional", or drop mcd_icd10 and filter with cause_icd10 instead.`,
      );
    }
    /**
     * Caught here rather than left to WONDER: the databases that do not list the marker reject
     * it as an invalid ICD-10 code and tell the caller to consult the finder tool, which reads
     * as "no such code" when the code is real and sitting on another database.
     */
    if (
      (causes.includes(WONDER_LAG_WITHHELD_CAUSE) ||
        mcdCauses.includes(WONDER_LAG_WITHHELD_CAUSE)) &&
      !spec.lagWithheldCause
    ) {
      throw ctx.fail(
        'invalid_query',
        `"${WONDER_LAG_WITHHELD_CAUSE}" is CDC's marker for causes withheld under the provisional database's six-month reporting lag, and only that database records them. ${spec.id} (${spec.title}) holds settled data with no withheld backlog and rejects the code. Select database "provisional", or filter on an ICD-10 code instead.`,
      );
    }

    const options: WonderQueryOptions = {
      database: input.database,
      groupBy: input.group_by,
      ...(causes.length > 0 ? { causeIcd10: causes } : {}),
      ...(mcdCauses.length > 0 ? { mcdIcd10: mcdCauses } : {}),
      sex: input.sex,
      ...(ageGroups ? { ageGroups } : {}),
      ...(input.year_range ? { yearRange: input.year_range } : {}),
    };

    /**
     * The table's size is bounded before the request, from the values each grouping dimension
     * can take: past the bound, WONDER takes longer than the request deadline to answer, and the
     * caller would see a retryable failure that no retry fixes.
     */
    const valueCounts = groupingValueCounts(options);
    const tableBound = valueCounts.reduce((product, { values }) => product * values, 1);
    if (tableBound > WONDER_MAX_TABLE_ROWS) {
      const factors = valueCounts
        .map(({ dimension, values }) => `${dimension} ${count(values)}`)
        .join(' × ');
      const nesting = valueCounts.flatMap(({ dimension, within }) =>
        within ? [`${within} already enumerates ${dimension}`] : [],
      );
      throw ctx.fail(
        'invalid_query',
        `group_by ${input.group_by.join(', ')} can produce up to ${count(tableBound)} rows on ${spec.id} (${factors}${nesting.length ? `; ${nesting.join(', ')}` : ''}), past the ${count(WONDER_MAX_TABLE_ROWS)}-row bound on one query's table — CDC WONDER takes longer than the 20-second request deadline to answer a table that large. Narrow year_range, filter sex or age_groups, or drop a dimension from group_by until the product is ${count(WONDER_MAX_TABLE_ROWS)} or less; a cause filter does not lower it.`,
      );
    }

    let result: WonderResult;
    try {
      result = await getWonderService().query(options, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message);
      }
      throw err;
    }

    const filters = [
      causes.length > 0 ? `underlying cause ${causes.join(' or ')}` : undefined,
      mcdCauses.length > 0 ? `any listed cause ${mcdCauses.join(' or ')}` : undefined,
      input.sex !== 'all' ? `sex ${input.sex}` : undefined,
      ageGroups?.length ? `ages ${ageGroups.join(',')}` : undefined,
      input.year_range ? `years ${input.year_range.from}–${input.year_range.to}` : undefined,
    ].filter(Boolean);
    const effectiveQuery = `${spec.id} — ${spec.title} · grouped by ${input.group_by.join(', ')}${
      filters.length ? ` · filtered by ${filters.join(', ')}` : ''
    }`;
    ctx.enrich({ effectiveQuery });

    /**
     * WONDER's request XML has no offset or limit, so the page is taken from the parsed table
     * rather than asked of CDC. That makes the total exact and free, and it makes the page a
     * pure view: every row CDC sent is reachable at some offset, and nothing about the query
     * changes between pages. The page is `limit` rows lowered to the per-call ceiling — with
     * `limit` omitted, the rest of the table up to that ceiling.
     */
    const total = result.rows.length;
    const pageSize = Math.min(input.limit ?? MAX_ROWS_PER_CALL, MAX_ROWS_PER_CALL);
    const rows = result.rows.slice(input.offset, input.offset + pageSize);

    /**
     * Cell notes index into the whole parsed table, and `format()` looks a token up by the
     * index of the row it is rendering. A page carrying the table's numbering therefore paints
     * `Suppressed` and `Unreliable` markers onto whichever rows happen to sit at those indices
     * in the page — so the notes are filtered to the rows returned and re-based onto them.
     */
    const cellNotes = result.cellNotes
      .filter((n) => n.row >= input.offset && n.row < input.offset + rows.length)
      .map((n) => ({ ...n, row: n.row - input.offset }));
    const consumed = input.offset + rows.length;
    const hasMore = consumed < total;
    const suppressedCount = cellNotes.filter((n) => isSuppressedToken(n.token)).length;

    /**
     * CDC's statements that it withheld whole rows, and what they mean for the counts. A stratum
     * hidden for recording zero deaths takes nothing from the deaths in `rows`; one hidden for a
     * suppressed count does, and so does one hidden for a reason CDC does not name. The wording
     * keys on the messages alone — never on the row count or the cause filter.
     */
    const hiddenRows = result.messages.flatMap((message) => {
      const kind = hiddenRowsKind(message);
      return kind ? [{ message, kind }] : [];
    });
    const zeroDeathsOnly =
      hiddenRows.length > 0 && hiddenRows.every(({ kind }) => kind === 'zero_deaths');

    /**
     * Every piece of guidance for this response, in reading order: where the page sits in the
     * table, then what CDC withheld or flagged, then how the rows relate (a nested cause list),
     * then what the selected database means for the figures — a multiple-cause twin, or the
     * provisional database's reporting lag. Flushed once, below — `notice` is last-wins, so
     * nothing else writes it.
     */
    const notices: string[] = [];
    if (total === 0) {
      if (hiddenRows.length === 0) {
        notices.push(
          'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
        );
      } else if (zeroDeathsOnly) {
        notices.push(
          'No rows came back because CDC recorded no deaths for this combination: the only rows it reported withholding are strata with zero deaths.',
        );
      } else {
        notices.push(
          'No rows came back, but CDC also reported withholding rows from this table — so an empty result here is not evidence that nothing matched; every matching stratum may have been hidden. Widen the query (more years, a broader cause or age range) so counts clear the suppression threshold.',
        );
      }
    } else if (input.offset >= total) {
      notices.push(
        `offset ${input.offset} is past the end of this table, which holds ${count(total)} row(s) — the query itself matched. Lower offset below ${count(total)} to see rows.`,
      );
    } else if (hasMore && pageSize === MAX_ROWS_PER_CALL) {
      const lowered = input.limit !== undefined && input.limit > MAX_ROWS_PER_CALL;
      notices.push(
        `Showing rows ${count(input.offset + 1)}–${count(consumed)} of ${count(total)}. One call returns at most ${count(MAX_ROWS_PER_CALL)} rows${lowered ? `, so limit=${input.limit} was lowered to ${MAX_ROWS_PER_CALL}` : ''}. Call again with offset=${consumed} for the next page — every page is a slice of the one table CDC sent, so the figures, caveats and messages do not change between them.`,
      );
    } else if (hasMore) {
      notices.push(
        `Showing rows ${count(input.offset + 1)}–${count(consumed)} of ${count(total)}. Call again with offset=${consumed} for the next page, or raise limit to pull more per call — every page is a slice of the one table CDC sent, so the figures, caveats and messages do not change between them.`,
      );
    } else if (rows.length < total) {
      notices.push(
        `Showing rows ${count(input.offset + 1)}–${count(consumed)} of ${count(total)} — the end of the table. The earlier rows are at lower offset values.`,
      );
    }
    if (suppressedCount > 0) {
      notices.push(
        `${suppressedCount} cell(s) were withheld by CDC for confidentiality (Suppressed) and are null. Aggregate over more years or a broader cause/age range to reduce suppression.`,
      );
    }
    if (hiddenRows.length > 0) {
      notices.push(
        `CDC withheld whole rows from this table — ${hiddenRows.map(({ message }) => message).join(' ')} (that is CDC's own wording, aimed at its web form; this tool has no input that unhides them). ${
          zeroDeathsOnly
            ? 'Each withheld stratum recorded zero deaths, so a stratum you expected and do not see had none and deaths summed from rows are complete; population summed from rows leaves those strata out.'
            : 'The withheld rows are absent from rows with nothing marking the gap, so a stratum you expected and do not see may have been dropped rather than unobserved; treat counts, rankings, and completeness claims drawn from rows as partial.'
        }`,
      );
    }
    const otherTokens = tallyOtherTokens(cellNotes, spec);
    if (otherTokens.length > 0) {
      notices.push(
        `CDC returned a status token instead of a number for some cells — ${otherTokens.join('; ')}. Those cells are null for the reason given, not suppressed for confidentiality; cellNotes gives the row index and column of each.`,
      );
    }
    // CDC's 113-cause list shows each aggregate cause beside the causes inside it, so its rows
    // are not additive the way every other grouping's are.
    if (input.group_by.includes('cause_113') && total > 0) {
      notices.push(
        'Rows grouped by cause_113 nest: cause_level gives each cause\'s depth in CDC\'s 113-cause list, and a cause below level 1 is part of the cause one level up that contains it — "Respiratory tuberculosis (A16)" within "#Tuberculosis (A16-A19)" — so its deaths are counted in that row too, and summing deaths across levels counts them more than once.',
      );
    }
    // A multiple-cause database with no multiple-cause filter counts each death once by its
    // underlying cause, so where an underlying-cause database covers the same years it returns
    // that one's figures to the digit. The provisional database has no such twin.
    const twin =
      spec.underlyingCauseTwin && mcdCauses.length === 0
        ? wonderDatabaseSpec(spec.underlyingCauseTwin)
        : undefined;
    if (twin) {
      notices.push(
        `${spec.id} records every cause listed on the death certificate, but with no mcd_icd10 filter it counts each death once by its underlying cause — these figures match what ${twin.id} (${twin.title}) returns for the same years. Add mcd_icd10 to count deaths with a condition recorded anywhere on the certificate, or switch to ${twin.id}.`,
      );
    }
    if (input.database === 'provisional') {
      notices.push(
        ...provisionalLagNotices({
          causeGroupings: input.group_by.filter((dim) => WONDER_CAUSE_GROUPINGS.has(dim)),
          causes,
          dataThrough: result.dataThrough,
          lastYear: spec.lastYear,
          mcdCauses,
          monthGrouped: input.group_by.includes('month'),
          years: input.year_range ?? { from: spec.firstYear, to: spec.lastYear },
        }),
      );
    }
    ctx.enrich.total(total);
    /**
     * `enrich.truncated()` writes `notice` itself and last-wins over `enrich.notice`, so the
     * continuation guidance has to arrive carrying the other notices rather than after them.
     */
    if (hasMore) {
      ctx.enrich.truncated({ shown: rows.length, cap: pageSize, guidance: notices.join(' ') });
      ctx.enrich({ nextOffset: consumed });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    ctx.log.info('WONDER query executed', {
      database: result.database,
      groupBy: input.group_by,
      totalCount: total,
      rowCount: rows.length,
      offset: input.offset,
      hasMore,
      cellNoteCount: cellNotes.length,
      suppressedCount,
      hiddenRowMessageCount: hiddenRows.length,
    });

    return {
      rows,
      rowCount: rows.length,
      database: result.database,
      databaseTitle: result.databaseTitle,
      caveats: result.caveats,
      cellNotes,
      messages: result.messages,
      suppressedCount,
    };
  },

  format: (result) => {
    // The database heads every render, rows or not — the same query against a different
    // database returns a different series, so a table that does not name its source is
    // ambiguous the moment two results sit side by side. An empty page renders the heading
    // alone: a page past the end and a query that matched nothing look the same from here, so
    // the cause reaches content[] only through the handler's notice.
    const lines: string[] = [
      `**${result.database} — ${result.databaseTitle} — ${result.rowCount} rows**`,
    ];
    const firstRow = result.rows[0];

    if (firstRow) {
      const columns = Object.keys(firstRow);
      const tokens = tokensByRow(result.cellNotes);
      lines.push('', ...renderTableHeader(columns));
      result.rows.forEach((row, index) => {
        lines.push(renderTableRow(row, columns, tokens.get(index)));
      });

      if (result.suppressedCount > 0) {
        lines.push(
          '',
          `_${result.suppressedCount} cell(s) withheld by CDC for confidentiality — shown as \`Suppressed\`, null in the data._`,
        );
      }
      const flagged = result.cellNotes.filter((n) => !isSuppressedToken(n.token));
      if (flagged.length > 0) {
        const database = wonderDatabaseSpecById(result.database);
        lines.push(
          '',
          '**Cells CDC returned as a status token in place of a number (null in the data, not suppressed for confidentiality):**',
          ...flagged.map((n) => `- ${describeCellNote(n, database)}`),
        );
      }
    }

    // Rendered for every result, not just the hidden-row case: a withheld row leaves no trace
    // in the table above, so this block is the only thing standing between a filtered row set
    // and a reader who takes it as complete.
    if (result.messages.length > 0) {
      lines.push(
        '',
        '**CDC notices on this table — rows may have been withheld before it was sent:**',
        ...result.messages.map((m) => `- ${m}`),
      );
    }

    if (result.caveats.length > 0) {
      lines.push('', '**Caveats:**', ...result.caveats.map((c) => `- ${c}`));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
