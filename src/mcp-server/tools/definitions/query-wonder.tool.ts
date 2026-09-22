/**
 * @fileoverview Tool to query CDC WONDER national mortality statistics across its five
 * mortality databases — final and provisional, underlying-cause and multiple-cause.
 * @module mcp-server/tools/definitions/query-wonder
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  isHiddenRowsMessage,
  isSuppressedToken,
  WONDER_AGE_GROUPS,
  WONDER_DATABASES,
  WONDER_GROUP_BY,
  WONDER_LAG_WITHHELD_CAUSE,
  WONDER_YEAR_BOUNDS,
  type WonderCellNote,
  type WonderQueryOptions,
  type WonderResult,
  type WonderRow,
  wonderDatabaseSpec,
} from '@/services/wonder/types.js';
import { getWonderService } from '@/services/wonder/wonder-service.js';
import { escapeTableCell } from '@/utils/markdown.js';
import { jsonLength, MAX_RESPONSE_CHARS } from '@/utils/response-budget.js';

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
 * One cause filter: `''` (every cause), the withheld-cause marker, an ICD-10 code or tree-node
 * range, or a list of the last two matched as a union. The single-value branches sit flat in
 * the top-level union — a nested union emits an `anyOf` branch with no `type`, which some
 * clients reject.
 */
const icd10Filter = (codeDescription: string) => {
  const code = z.string().regex(ICD10_CODE_OR_RANGE).describe(codeDescription);
  const marker = z.literal(WONDER_LAG_WITHHELD_CAUSE);
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
      .min(1)
      .max(MAX_ICD10_CODES)
      .describe(
        `A list of 1–${MAX_ICD10_CODES} entries, each in the single-value form, matched as a union: a death counts once when it matches any of them, so a code set such as X40–X44 plus X60–X64 is one series with one set of rates. Repeated entries are ignored.`,
      ),
  ]);
};

/** Normalize a cause filter to a deduplicated list; empty when the filter is absent or `''`. */
function causeCodes(value: string | string[] | undefined): string[] {
  if (value === undefined || value === '') return [];
  return [...new Set(Array.isArray(value) ? value : [value])];
}

/**
 * Ceiling on `limit`, matching the shape `cdc_query_dataset` uses. It never binds ahead of
 * the table itself: the widest grouping WONDER can be asked for — 22 years × 12 age groups ×
 * 2 sexes × 4 race groups on D76 — tops out near 2,100 combinations before CDC hides the
 * zero-death and suppressed-death rows.
 */
const MAX_LIMIT = 5000;
/** Ceiling on `offset`, comfortably past the largest table any grouping can produce. */
const MAX_OFFSET = 10_000;
/**
 * Characters held back from the `MAX_RESPONSE_CHARS` row budget for the parts of the response
 * whose size does not depend on the caller's data: the result keys, the table heading, the
 * section headings under the table, the enrichment trailer's labels, and the notices that
 * depend on the page — its row range and continuation, the suppression count, the token
 * tally — each of which reaches both surfaces. Those notices at their longest, doubled, come to
 * about 2,000 characters. Everything sized by CDC's text or the caller's query — caveats,
 * messages, the notices that quote them, the query echo — is measured per call in the handler.
 */
const FRAMING_RESERVE = 4_000;

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
 * apart from a blank. Shared with the budget so a row is charged what is rendered.
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
 * Characters a list of whole-table strings costs across both surfaces: the JSON array in
 * `structuredContent` plus one `- item` line each in `content[]`.
 */
function listCost(items: readonly string[]): number {
  return JSON.stringify(items).length + items.reduce((n, item) => n + jsonLength(`- ${item}\n`), 0);
}

/**
 * Take rows from the head of `page` until the next one would carry the serialized response
 * past `MAX_RESPONSE_CHARS`, and return how many fit. Every row carries the same columns, so
 * the table heading is charged once, up front, rather than per row. A row costs
 * its JSON plus its rendered table line; each of its cell notes costs its JSON plus, for any
 * token other than `Suppressed`, its itemized line under the table. `notes` must already be
 * re-based onto `page`, so every figure charged is the one that ships. Always keeps the first
 * row: a single row wider than the whole budget still has to come back as a row, not as an
 * empty page that reads like "nothing matched".
 */
function rowsWithinBudget(
  page: readonly WonderRow[],
  notes: readonly WonderCellNote[],
  reserved: number,
): number {
  const columns = page[0] ? Object.keys(page[0]) : [];
  const notesByRow = Map.groupBy(notes, (note) => note.row);
  const tokens = tokensByRow(notes);
  let used = reserved + jsonLength(`${renderTableHeader(columns).join('\n')}\n`);
  for (const [index, row] of page.entries()) {
    // The row inside the JSON array plus its comma, then its table line plus the newline.
    used += JSON.stringify(row).length + 1;
    used += jsonLength(`${renderTableRow(row, columns, tokens.get(index))}\n`);
    for (const note of notesByRow.get(index) ?? []) {
      used += JSON.stringify(note).length + 1;
      if (!isSuppressedToken(note.token)) used += jsonLength(`- ${describeCellNote(note)}\n`);
    }
    if (used > MAX_RESPONSE_CHARS) return Math.max(index, 1);
  }
  return page.length;
}

/**
 * What each non-suppression CDC status token means, keyed by the lowercased token.
 * Suppression is reported through its own count and wording, so it is not listed here.
 */
const TOKEN_MEANING: Record<string, string> = {
  unreliable:
    'published but statistically unstable — the rate is computed from fewer than 20 deaths',
  'not applicable': 'not computable — the population denominator is unavailable',
};

/** `: <meaning>` suffix for a token CDC documents; empty for one it does not. */
function gloss(token: string): string {
  const meaning = TOKEN_MEANING[token.toLowerCase()];
  return meaning ? `: ${meaning}` : '';
}

/** Render one cell note as ``row 3, `crude_rate` — `Unreliable`: <meaning>``. */
function describeCellNote(note: WonderCellNote): string {
  return `row ${note.row}, \`${note.column}\` — \`${note.token}\`${gloss(note.token)}`;
}

/**
 * Tally the status tokens other than "Suppressed" (which has its own count field) by token
 * text, in first-seen order, as `Unreliable (2 cells): <meaning>` phrases.
 */
function tallyOtherTokens(cellNotes: WonderCellNote[]): string[] {
  const counts = new Map<string, number>();
  for (const note of cellNotes) {
    if (isSuppressedToken(note.token)) continue;
    counts.set(note.token, (counts.get(note.token) ?? 0) + 1);
  }
  return [...counts].map(
    ([token, n]) => `${token} (${n} cell${n === 1 ? '' : 's'})${gloss(token)}`,
  );
}

export const queryWonder = tool('cdc_query_wonder', {
  description: `Query CDC WONDER for national US mortality statistics — deaths, population, and crude/age-adjusted death rates — across its five mortality databases, selected with the database input: final underlying-cause data for 1999–2020 (the default) or 2018–2024, provisional data running from 2018 through the current year, and two multiple-cause databases covering the same two eras. Break results out by year, age group, sex, and/or race, and filter by ICD-10 cause of death, sex, age group, or year range; on a multiple-cause database, mcd_icd10 additionally matches a cause listed anywhere on the death certificate rather than only the one certified as underlying. Each database holds a different span of years (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last} across all of them) and a request whose year_range falls outside the selected one's span is rejected with that span named. WONDER is a separate CDC system from the Socrata datasets the other cdc_* tools query. Data is national only — sub-national (state/county) breakdowns are not available through the API (CDC vital-statistics policy). Cause of death is a filter, not a grouping. Some measure cells come back as a CDC status token rather than a number — "Suppressed" (withheld for confidentiality), "Unreliable" (a rate from fewer than 20 deaths), or "Not Applicable" (no population denominator); those cells read null in rows and each one is listed in cellNotes with its token. CDC also drops whole rows before sending the table — strata with zero deaths, and strata whose death count is suppressed — so a stratum can be missing from rows entirely; messages carries CDC's statement whenever that happened. Each response is bounded by a ${MAX_RESPONSE_CHARS.toLocaleString('en-US')}-character budget counted over the whole result, so a broad grouping — one can run past two thousand rows — comes back a page at a time: the response reports the table's totalCount and a nextOffset to continue from, and limit takes smaller pages. Paging shapes the response only — WONDER is asked once either way, and the figures, caveats and hidden-row notices are the same on every page. CDC rejects requests made less than 15 seconds apart across all five databases, so calls are spaced automatically: calls made while another is running wait their turn and run one after another, each queued call adding about 16 seconds plus its own query time before it returns.`,
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The request contradicts itself — a year_range whose from is later than its to, or a group_by dimension listed twice — or does not fit the selected database — a year_range outside the years it holds, mcd_icd10 against a database that records only the underlying cause, or the withheld-cause marker against one that keeps no withheld backlog — or WONDER itself rejected it, e.g. an ICD-10 code or range its tree does not hold, or a filter/grouping combination it does not allow.',
      recovery:
        'Read the returned message: it names the input at fault, the span the selected database holds, the databases that accept mcd_icd10 or the withheld-cause marker, or the part WONDER rejected. Fix year_range or group_by, switch database, drop the filter, or correct the ICD-10 code, then retry.',
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
      when: 'WONDER returned an unexpected response or was unreachable.',
      retryable: true,
      recovery: 'Retry after a brief delay; wonder.cdc.gov may be temporarily unavailable.',
    },
  ],

  input: z.object({
    database: z
      .enum(WONDER_DATABASES)
      .default('underlying_1999_2020')
      .describe(
        'Which WONDER mortality database to query. "underlying_1999_2020" (D76) is final data for 1999–2020 and the default. "provisional" (D176) runs 2018 through the current year, updated weekly, and returns the most recent years labelled e.g. "2025 (provisional)". "underlying_2018_2024" (D158) is settled — not provisional — data for 2018–2024. "multiple_1999_2020" (D77) and "multiple_2018_2024" (D157) record every cause listed on the death certificate; without an mcd_icd10 filter they return the same figures as the underlying-cause database for the same era, so pick one only to use that filter. The two 1999–2020 databases report race in CDC\'s four bridged groups; the other three use the six single-race groups — figures broken out by race are not comparable between the two families.',
      ),
    group_by: z
      .array(z.enum(WONDER_GROUP_BY))
      .min(1)
      .max(4)
      .default(['year'])
      .describe(
        'Dimensions to break results out by (1–4, each at most once), in output-column order — e.g. ["year"], ["year","sex"], ["age_group","race"]. Results are always national. Cause of death is a filter (cause_icd10), not a grouping. "race" resolves to whichever race vocabulary the selected database uses — four bridged groups (Asian and Pacific Islander combined) on the 1999–2020 databases, six single-race categories on the others, one of them "More than one race" — so a race series from one family cannot be spliced onto one from the other.',
      ),
    cause_icd10: icd10Filter(
      'ICD-10 underlying-cause code or range. WONDER takes a node of its ICD-10 tree — a chapter such as "A00-B99" (infectious) or "V01-Y89" (external causes), a block such as "X40-X49" (accidental poisoning) or "C00-C97" (malignant neoplasms), or a single code such as "I21" — and rejects any other span, e.g. "X40-X44", naming it in the error. List the codes (or blocks) to cover a span that is not a tree node.',
    )
      .optional()
      .describe(
        `Filter to ICD-10 underlying causes of death — the single condition CDC certified as having started the chain of events leading to death. Takes one code or range, or a list of them for a cause defined as a code set, e.g. drug overdose as ["X40","X41","X42","X43","X44","X60","X61","X62","X63","X64","X85","Y10","Y11","Y12","Y13","Y14"]. Omit for all causes. Accepted by every database. "${WONDER_LAG_WITHHELD_CAUSE}" is not an ICD-10 code but CDC's own marker for deaths whose cause it is still withholding under the provisional database's six-month reporting lag; it counts that backlog, and only the "provisional" database offers it.`,
      ),
    mcd_icd10: icd10Filter(
      'ICD-10 code or range, same form as cause_icd10 — a chapter such as "S00-T98" (injury and poisoning, a chapter the underlying-cause finder does not list), a block such as "J09-J18" (influenza and pneumonia), or a single code such as "T40.1" (heroin).',
    )
      .optional()
      .describe(
        `Filter to deaths with any of these ICD-10 codes recorded anywhere on the death certificate, whether or not it was the underlying cause — e.g. "died with a respiratory condition listed", a population no underlying-cause query can produce. Takes one code or range, or a list of them, e.g. opioid involvement as ["T40.0","T40.1","T40.2","T40.3","T40.4","T40.6"]. Valid only when database is "multiple_1999_2020", "multiple_2018_2024", or "provisional"; the other databases record only the underlying cause and reject it. "${WONDER_LAG_WITHHELD_CAUSE}", the withheld-cause marker described under cause_icd10, is offered here too but only by "provisional". Combines with cause_icd10, which keeps meaning the underlying cause: a death must match both filters. Omit for all causes.`,
      ),
    sex: z.enum(['all', 'male', 'female']).default('all').describe('Filter by sex.'),
    age_groups: z
      .array(z.enum(WONDER_AGE_GROUPS))
      .optional()
      .describe(
        'Restrict to deaths in any of the listed age groups — e.g. ["25-34","35-44"] covers both; a repeated group counts once. "1" is the under-1-year group. "NS" is the group CDC puts a death in when the age was not recorded; it is not covered by any of the ten-year groups, so a filter listing all eleven of those still leaves those deaths out and returns fewer deaths than the same query unfiltered. List "NS" alongside them to match an unfiltered total, or on its own to count them. Omit for all ages, which includes them.',
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
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Rows to return from the table CDC sent (1–${MAX_LIMIT}). Omit to take as many as fit. Either way fewer come back when the page would carry the response past its ${MAX_RESPONSE_CHARS.toLocaleString('en-US')}-character budget, counted over the whole result — the rows, their cell notes, and the caveats and messages, as JSON and as the rendered table together; the response says so and gives a nextOffset to resume from. WONDER's request carries no limit of its own, so this pages a table already fetched in full rather than narrowing the query: the deaths, rates, caveats and hidden-row notices are the same whichever page is read.`,
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
        'Result rows. Each carries the requested group-by dimensions plus deaths, population, crude_rate, and age_adjusted_rate (per 100,000) when age standardization is possible — it is omitted when age_group is a grouping dimension or age_groups selects a single group. Dimension values are CDC\'s own labels with only surrounding whitespace removed, so the same year keys identically across databases; nothing inside a label is changed, and on the provisional database a year reads "2025 (provisional)" or "2026 (provisional and partial)" rather than a bare year. A measure cell CDC returned as a status token instead of a number is null here; cellNotes names the cell and the token. These are one page of the table CDC sent, in its order, bounded by limit and by the response budget; totalCount says how many rows the whole table holds.',
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
                'Token CDC returned in place of a number: "Suppressed" (withheld for confidentiality, fewer than 10 persons), "Unreliable" (rate from fewer than 20 deaths — published, not withheld), or "Not Applicable" (no population denominator).',
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
        'Notices CDC attached to this table, verbatim apart from links, which are kept as Markdown links. The ones that matter say rows were withheld before the table was sent — "Rows with zero Deaths are hidden." and "Rows with suppressed Deaths are hidden." A withheld row is absent from rows entirely, with nothing in the table marking the gap, so while this array is non-empty a stratum missing from rows may have been dropped rather than unobserved, and any count, ranking, or completeness claim drawn from rows is partial. These describe the whole table, so they come back complete on every page. Empty when CDC withheld no rows.',
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
        'Rows this call asked for — limit when set, otherwise every row from offset to the end of the table. A shown below it means the response budget cut the page short.',
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
        'Guidance when no rows matched, when the returned rows are a page of a larger table — naming whether limit or the response budget ended it — or the offset ran past it, and a note when CDC returned a status token in place of a measure value.',
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
        { ...ctx.recoveryFor('invalid_query') },
      );
    }
    if (input.year_range && input.year_range.from > input.year_range.to) {
      throw ctx.fail(
        'invalid_query',
        `year_range runs backwards: from ${input.year_range.from} is later than to ${input.year_range.to}. Swap them so from is the earlier year.`,
        { ...ctx.recoveryFor('invalid_query') },
      );
    }
    if (
      input.year_range &&
      (input.year_range.from < spec.firstYear || input.year_range.to > spec.lastYear)
    ) {
      throw ctx.fail(
        'invalid_query',
        `${spec.id} (${spec.title}) holds ${spec.firstYear}–${spec.lastYear}; year_range ${input.year_range.from}–${input.year_range.to} falls outside it. Narrow the range or select a database whose span covers those years.`,
        { ...ctx.recoveryFor('invalid_query') },
      );
    }
    if (mcdCauses.length > 0 && !spec.multipleCause) {
      throw ctx.fail(
        'invalid_query',
        `mcd_icd10 needs a database that records every cause on the death certificate. ${spec.id} (${spec.title}) records only the underlying cause. Use database "multiple_1999_2020", "multiple_2018_2024", or "provisional", or drop mcd_icd10 and filter with cause_icd10 instead.`,
        { ...ctx.recoveryFor('invalid_query') },
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
        { ...ctx.recoveryFor('invalid_query') },
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

    let result: WonderResult;
    try {
      result = await getWonderService().query(options, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
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
     * changes between pages.
     */
    const total = result.rows.length;
    // The rows this call asked for: `limit` when set, otherwise the rest of the table.
    const take = input.limit ?? Math.max(total - input.offset, 0);
    const requested = result.rows.slice(input.offset, input.offset + take);

    /**
     * Cell notes index into the whole parsed table, and `format()` looks a token up by the
     * index of the row it is rendering. A page carrying the table's numbering therefore paints
     * `Suppressed` and `Unreliable` markers onto whichever rows happen to sit at those indices
     * in the page — so the notes are filtered to the rows returned and re-based onto them.
     */
    const requestedNotes = result.cellNotes
      .filter((n) => n.row >= input.offset && n.row < input.offset + requested.length)
      .map((n) => ({ ...n, row: n.row - input.offset }));

    const hiddenRowMessages = result.messages.filter(isHiddenRowsMessage);
    const hiddenRowsNotice =
      hiddenRowMessages.length > 0
        ? `CDC withheld whole rows from this table — ${hiddenRowMessages.join(' ')} (that is CDC's own wording, aimed at its web form; this tool has no input that unhides them). The withheld rows are absent from rows with nothing marking the gap, so a stratum you expected and do not see may have been dropped rather than unobserved; treat counts, rankings, and completeness claims drawn from rows as partial.`
        : undefined;
    // A multiple-cause database with no multiple-cause filter counts each death once by its
    // underlying cause, so where an underlying-cause database covers the same years it returns
    // that one's figures to the digit. The provisional database has no such twin.
    const twin =
      spec.underlyingCauseTwin && mcdCauses.length === 0
        ? wonderDatabaseSpec(spec.underlyingCauseTwin)
        : undefined;
    const twinNotice = twin
      ? `${spec.id} records every cause listed on the death certificate, but with no mcd_icd10 filter it counts each death once by its underlying cause — these figures match what ${twin.id} (${twin.title}) returns for the same years. Add mcd_icd10 to count deaths with a condition recorded anywhere on the certificate, or switch to ${twin.id}.`
      : undefined;

    /**
     * The page is bounded by the response budget as well as by `limit`. What every page
     * carries whatever its rows — the caveats and messages, whole on each page and on both
     * surfaces; the notices that quote CDC's text or name the database; the query echo in
     * `structuredContent` and in the trailer — is measured here rather than guessed, since CDC
     * decides its length. Only then are rows taken until the budget runs out.
     */
    const reserved =
      FRAMING_RESERVE +
      listCost(result.caveats) +
      listCost(result.messages) +
      2 * jsonLength(hiddenRowsNotice ?? '') +
      2 * jsonLength(twinNotice ?? '') +
      2 * jsonLength(effectiveQuery);
    const kept = rowsWithinBudget(requested, requestedNotes, reserved);
    const rows = requested.slice(0, kept);
    const cellNotes = requestedNotes.filter((n) => n.row < kept);
    const budgetCut = kept < requested.length;
    const consumed = input.offset + rows.length;
    const hasMore = consumed < total;
    const suppressedCount = cellNotes.filter((n) => isSuppressedToken(n.token)).length;

    const notices: string[] = [];
    if (total === 0) {
      notices.push(
        hiddenRowMessages.length > 0
          ? 'No rows came back, but CDC also reported withholding rows from this table — so an empty result here is not evidence that nothing matched; every matching stratum may have been hidden. Widen the query (more years, a broader cause or age range) so counts clear the suppression threshold.'
          : 'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
      );
    } else if (input.offset >= total) {
      notices.push(
        `offset ${input.offset} is past the end of this table, which holds ${total} row(s) — the query itself matched. Lower offset below ${total} to see rows.`,
      );
    } else if (budgetCut) {
      notices.push(
        `Showing rows ${input.offset + 1}–${consumed} of ${total}. The ${MAX_RESPONSE_CHARS.toLocaleString('en-US')}-character response budget cut the page at ${rows.length} of the ${requested.length} rows ${input.limit === undefined ? 'left in the table from this offset' : `limit=${input.limit} would have returned`} — it counts the rows, their cell notes, and the caveats and messages that come back whole on every page, as JSON and as the rendered table together. Call again with offset=${consumed} for the next page; a higher limit does not return more per call. Every page is a slice of the one table CDC sent, so the figures, caveats and messages do not change between them.`,
      );
    } else if (hasMore) {
      notices.push(
        `Showing rows ${input.offset + 1}–${consumed} of ${total}. Call again with offset=${consumed} for the next page, or raise limit (max ${MAX_LIMIT}) to pull more per call — every page is a slice of the one table CDC sent, so the figures, caveats and messages do not change between them.`,
      );
    } else if (rows.length < total) {
      notices.push(
        `Showing rows ${input.offset + 1}–${consumed} of ${total} — the end of the table. The earlier rows are at lower offset values.`,
      );
    }
    if (suppressedCount > 0) {
      notices.push(
        `${suppressedCount} cell(s) were withheld by CDC for confidentiality (Suppressed) and are null. Aggregate over more years or a broader cause/age range to reduce suppression.`,
      );
    }
    if (hiddenRowsNotice) notices.push(hiddenRowsNotice);
    const otherTokens = tallyOtherTokens(cellNotes);
    if (otherTokens.length > 0) {
      notices.push(
        `CDC returned a status token instead of a number for some cells — ${otherTokens.join('; ')}. Those cells are null but were not withheld; cellNotes gives the row index and column of each.`,
      );
    }
    if (twinNotice) notices.push(twinNotice);
    ctx.enrich.total(total);
    /**
     * `enrich.truncated()` writes `notice` itself and last-wins over `enrich.notice`, so the
     * continuation guidance has to arrive carrying the other notices rather than after them.
     */
    if (hasMore) {
      ctx.enrich.truncated({ shown: rows.length, cap: take, guidance: notices.join(' ') });
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
      hiddenRowMessageCount: hiddenRowMessages.length,
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
    // ambiguous the moment two results sit side by side.
    const lines: string[] = [
      `**${result.database} — ${result.databaseTitle} — ${result.rowCount} rows**`,
      '',
    ];
    const firstRow = result.rows[0];

    if (firstRow) {
      const columns = Object.keys(firstRow);
      const tokens = tokensByRow(result.cellNotes);
      lines.push(...renderTableHeader(columns));
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
        lines.push(
          '',
          '**Cells CDC returned as a status token (null in the data, not withheld):**',
          ...flagged.map((n) => `- ${describeCellNote(n)}`),
        );
      }
    } else if (result.messages.some(isHiddenRowsMessage)) {
      lines.push(
        'No rows came back, and CDC reported withholding rows from this table — an empty result here is not evidence that nothing matched. Widen the query (more years, a broader cause or age range) so counts clear the suppression threshold.',
      );
    } else {
      lines.push(
        'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
      );
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
