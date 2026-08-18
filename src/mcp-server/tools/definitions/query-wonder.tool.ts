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
  wonderDatabaseSpec,
} from '@/services/wonder/types.js';
import { getWonderService } from '@/services/wonder/wonder-service.js';
import { escapeTableCell } from '@/utils/markdown.js';

/**
 * An ICD-10 code or chapter range, e.g. "I21", "C00-C97", "V01-Y89". Shared by cause_icd10 and
 * mcd_icd10, whose descriptions say they take the same form — one pattern keeps that true.
 */
const ICD10_CODE_OR_RANGE = /^[A-Z][0-9]{2}(\.[0-9]+)?(-[A-Z][0-9]{2}(\.[0-9]+)?)?$/;

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
  description: `Query CDC WONDER for national US mortality statistics — deaths, population, and crude/age-adjusted death rates — across its five mortality databases, selected with the database input: final underlying-cause data for 1999–2020 (the default) or 2018–2024, provisional data running from 2018 through the current year, and two multiple-cause databases covering the same two eras. Break results out by year, age group, sex, and/or race, and filter by ICD-10 cause of death, sex, age group, or year range; on a multiple-cause database, mcd_icd10 additionally matches a cause listed anywhere on the death certificate rather than only the one certified as underlying. Each database holds a different span of years (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last} across all of them) and a request whose year_range falls outside the selected one's span is rejected with that span named. WONDER is a separate CDC system from the Socrata datasets the other cdc_* tools query. Data is national only — sub-national (state/county) breakdowns are not available through the API (CDC vital-statistics policy). Cause of death is a filter, not a grouping. Some measure cells come back as a CDC status token rather than a number — "Suppressed" (withheld for confidentiality), "Unreliable" (a rate from fewer than 20 deaths), or "Not Applicable" (no population denominator); those cells read null in rows and each one is listed in cellNotes with its token. CDC also drops whole rows before sending the table — strata with zero deaths, and strata whose death count is suppressed — so a stratum can be missing from rows entirely; messages carries CDC's statement whenever that happened. The whole table comes back by default; a broad grouping can run past a thousand rows, so set limit to take it a page at a time and follow the nextOffset the response reports. Paging shapes the response only — WONDER is asked once either way, and the figures, caveats and hidden-row notices are the same on every page. CDC rejects requests made less than 15 seconds apart across all five databases, so consecutive calls are spaced automatically and a follow-up call may wait about 16 seconds before it runs.`,
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The request does not fit the selected database — a year_range outside the years it holds, mcd_icd10 against a database that records only the underlying cause, or the withheld-cause marker against one that keeps no withheld backlog — or WONDER itself rejected it, e.g. an unknown ICD-10 code or a filter/grouping combination it does not allow.',
      recovery:
        'Read the returned message: it names the span the selected database holds, the databases that accept mcd_icd10 or the withheld-cause marker, or the part WONDER rejected. Adjust year_range, switch database, drop the filter, or correct the ICD-10 code, then retry.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'A request reached WONDER less than 15 seconds after the previous response finished, and WONDER returned 429.',
      retryable: true,
      recovery:
        'Wait at least 16 seconds after the previous response completes, then retry the same query.',
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
        'Dimensions to break results out by (1–4), in output-column order — e.g. ["year"], ["year","sex"], ["age_group","race"]. Results are always national. Cause of death is a filter (cause_icd10), not a grouping. "race" resolves to whichever race vocabulary the selected database uses — four bridged groups (Asian and Pacific Islander combined) on the 1999–2020 databases, six single-race groups plus a multiracial category on the others — so a race series from one family cannot be spliced onto one from the other.',
      ),
    cause_icd10: z
      .union([
        z.literal(''),
        z.literal(WONDER_LAG_WITHHELD_CAUSE),
        z
          .string()
          .regex(ICD10_CODE_OR_RANGE)
          .describe(
            'ICD-10 underlying-cause code or chapter range. Ranges must match WONDER chapter boundaries exactly (an invalid code is rejected and named in the error) — valid examples: "A00-B99" (infectious), "C00-C97" (malignant neoplasms), "I00-I99" (circulatory), "J00-J98" (respiratory), "V01-Y89" (external causes), or a single code like "I21".',
          ),
      ])
      .optional()
      .describe(
        `Filter to a specific ICD-10 underlying cause of death — the single condition CDC certified as having started the chain of events leading to death. Omit for all causes. Accepted by every database. "${WONDER_LAG_WITHHELD_CAUSE}" is not an ICD-10 code but CDC's own marker for deaths whose cause it is still withholding under the provisional database's six-month reporting lag; it counts that backlog, and only the "provisional" database offers it.`,
      ),
    mcd_icd10: z
      .union([
        z.literal(''),
        z.literal(WONDER_LAG_WITHHELD_CAUSE),
        z
          .string()
          .regex(ICD10_CODE_OR_RANGE)
          .describe(
            'ICD-10 code or chapter range, same form as cause_icd10 — e.g. "J00-J98" (respiratory), "E00-E89" (endocrine/metabolic), "S00-T98" (injury and poisoning, a chapter the underlying-cause finder does not list), or a single code like "I21".',
          ),
      ])
      .optional()
      .describe(
        `Filter to deaths with this ICD-10 code recorded anywhere on the death certificate, whether or not it was the underlying cause — e.g. "died with a respiratory condition listed", a population no underlying-cause query can produce. Valid only when database is "multiple_1999_2020", "multiple_2018_2024", or "provisional"; the other databases record only the underlying cause and reject it. "${WONDER_LAG_WITHHELD_CAUSE}", the withheld-cause marker described under cause_icd10, is offered here too but only by "provisional". Combines with cause_icd10, which keeps meaning the underlying cause. Omit for all causes.`,
      ),
    sex: z.enum(['all', 'male', 'female']).default('all').describe('Filter by sex.'),
    age_groups: z
      .array(z.enum(WONDER_AGE_GROUPS))
      .optional()
      .describe(
        'Restrict to deaths in any of the listed age groups — e.g. ["25-34","35-44"] covers both. "1" is the under-1-year group. "NS" is the group CDC puts a death in when the age was not recorded; it is not covered by any of the ten-year groups, so a filter listing all eleven of those still leaves those deaths out and returns fewer deaths than the same query unfiltered. List "NS" alongside them to match an unfiltered total, or on its own to count them. Omit for all ages, which includes them.',
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
      .refine((r) => r.from <= r.to, { message: 'from must be less than or equal to to' })
      .optional()
      .describe(
        `Inclusive year range. These bounds span every database (${WONDER_YEAR_BOUNDS.first}–${WONDER_YEAR_BOUNDS.last}); the years the selected one actually holds are narrower, and a range outside them is rejected with that database's span named. Omit for all years the database holds.`,
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Rows to return from the table CDC sent (1–${MAX_LIMIT}). Omit to return the whole table. WONDER's request carries no limit of its own, so this pages a table already fetched in full rather than narrowing the query: the deaths, rates, caveats and hidden-row notices are the same whichever page is read. A four-dimension grouping can run past a thousand rows, so set this and follow nextOffset to walk them.`,
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
        'Result rows. Each carries the requested group-by dimensions plus deaths, population, crude_rate, and age_adjusted_rate (per 100,000) when age standardization is possible — it is omitted when age_group is a grouping dimension or age_groups selects a single group. Dimension values are CDC\'s own labels with only surrounding whitespace removed, so the same year keys identically across databases; nothing inside a label is changed, and on the provisional database a year reads "2025 (provisional)" or "2026 (provisional and partial)" rather than a bare year. A measure cell CDC returned as a status token instead of a number is null here; cellNotes names the cell and the token. When limit or offset is set these are one page of the table CDC sent, in its order; totalCount says how many rows the whole table holds.',
      ),
    rowCount: z
      .number()
      .describe(
        'Number of rows returned in this response — the page size when limit or offset is set.',
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
        'CDC-provided caveats and footnotes: data revisions, population-estimate sources, suppression and rate-reliability rules. They describe the whole table CDC assembled, so they come back complete on every page rather than scoped to the rows returned.',
      ),
    cellNotes: z
      .array(
        z
          .object({
            row: z
              .number()
              .describe(
                'Zero-based index into rows — the rows in this response, so it is relative to the page when limit or offset is set.',
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
        'Notices CDC attached to this table, verbatim. The ones that matter say rows were withheld before the table was sent — "Rows with zero Deaths are hidden." and "Rows with suppressed Deaths are hidden." A withheld row is absent from rows entirely, with nothing in the table marking the gap, so while this array is non-empty a stratum missing from rows may have been dropped rather than unobserved, and any count, ranking, or completeness claim drawn from rows is partial. These describe the whole table, so they come back complete on every page. Empty when CDC withheld no rows.',
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
        'Rows in the whole table CDC returned, before limit/offset. Exact rather than estimated — the table is parsed in full before a page is taken from it.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows remain past the ones returned. Absent means this response runs to the end of the table, which is also the case for an offset past it.',
      ),
    shown: z.number().optional().describe('Number of rows returned in this response.'),
    cap: z.number().optional().describe('The requested limit that bounded this response.'),
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
        'Guidance when no rows matched, when the returned rows are a page of a larger table or the offset ran past it, and a note when CDC returned a status token in place of a measure value.',
      ),
  },

  async handler(input, ctx) {
    const spec = wonderDatabaseSpec(input.database);

    /**
     * All three cross-field checks live here rather than in a Zod refinement. A refinement adds
     * nothing to the emitted JSON Schema, so a client never sees the constraint, and a schema
     * rejection throws a raw ZodError as -32602 at the transport before the handler runs —
     * which puts the declared recovery hint out of reach.
     */
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
    if (input.mcd_icd10 && !spec.multipleCause) {
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
      (input.cause_icd10 === WONDER_LAG_WITHHELD_CAUSE ||
        input.mcd_icd10 === WONDER_LAG_WITHHELD_CAUSE) &&
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
      ...(input.cause_icd10 ? { causeIcd10: input.cause_icd10 } : {}),
      ...(input.mcd_icd10 ? { mcdIcd10: input.mcd_icd10 } : {}),
      sex: input.sex,
      ...(input.age_groups ? { ageGroups: input.age_groups } : {}),
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
      input.cause_icd10 ? `underlying cause ${input.cause_icd10}` : undefined,
      input.mcd_icd10 ? `any listed cause ${input.mcd_icd10}` : undefined,
      input.sex !== 'all' ? `sex ${input.sex}` : undefined,
      input.age_groups?.length ? `ages ${input.age_groups.join(',')}` : undefined,
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
    const take = input.limit ?? Math.max(total - input.offset, 0);
    const rows = result.rows.slice(input.offset, input.offset + take);
    const consumed = input.offset + rows.length;
    const hasMore = consumed < total;

    /**
     * Cell notes index into the whole parsed table, and `format()` looks a token up by the
     * index of the row it is rendering. A page carrying the table's numbering therefore paints
     * `Suppressed` and `Unreliable` markers onto whichever rows happen to sit at those indices
     * in the page — so the notes are filtered to the rows returned and re-based onto them.
     */
    const cellNotes = result.cellNotes
      .filter((n) => n.row >= input.offset && n.row < consumed)
      .map((n) => ({ ...n, row: n.row - input.offset }));
    const suppressedCount = cellNotes.filter((n) => isSuppressedToken(n.token)).length;

    const hiddenRowMessages = result.messages.filter(isHiddenRowsMessage);

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
    if (hiddenRowMessages.length > 0) {
      notices.push(
        `CDC withheld whole rows from this table — ${hiddenRowMessages.join(' ')} (that is CDC's own wording, aimed at its web form; this tool has no input that unhides them). The withheld rows are absent from rows with nothing marking the gap, so a stratum you expected and do not see may have been dropped rather than unobserved; treat counts, rankings, and completeness claims drawn from rows as partial.`,
      );
    }
    const otherTokens = tallyOtherTokens(cellNotes);
    if (otherTokens.length > 0) {
      notices.push(
        `CDC returned a status token instead of a number for some cells — ${otherTokens.join('; ')}. Those cells are null but were not withheld; cellNotes gives the row index and column of each.`,
      );
    }
    // A multiple-cause database with no multiple-cause filter counts each death once by its
    // underlying cause, so where an underlying-cause database covers the same years it returns
    // that one's figures to the digit. The provisional database has no such twin.
    if (spec.underlyingCauseTwin && !input.mcd_icd10) {
      const twin = wonderDatabaseSpec(spec.underlyingCauseTwin);
      notices.push(
        `${spec.id} records every cause listed on the death certificate, but with no mcd_icd10 filter it counts each death once by its underlying cause — these figures match what ${twin.id} (${twin.title}) returns for the same years. Add mcd_icd10 to count deaths with a condition recorded anywhere on the certificate, or switch to ${twin.id}.`,
      );
    }
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
      // A cell CDC replaced with a status token is null in `rows`; render the token in its
      // place so a content[]-only client can tell it apart from a blank cell.
      const tokenAt = new Map(result.cellNotes.map((n) => [`${n.row}:${n.column}`, n.token]));
      lines.push(`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`);
      result.rows.forEach((row, index) => {
        const cells = columns.map((c) => {
          const v = tokenAt.get(`${index}:${c}`) ?? row[c];
          return escapeTableCell(v == null ? '' : String(v));
        });
        lines.push(`| ${cells.join(' | ')} |`);
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
