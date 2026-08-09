/**
 * @fileoverview Tool to query CDC WONDER national mortality statistics (database D76).
 * @module mcp-server/tools/definitions/query-wonder
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  isSuppressedToken,
  WONDER_AGE_GROUPS,
  WONDER_DATABASE_NAME,
  WONDER_GROUP_BY,
  type WonderCellNote,
  type WonderQueryOptions,
  type WonderResult,
} from '@/services/wonder/types.js';
import { getWonderService } from '@/services/wonder/wonder-service.js';
import { escapeTableCell } from '@/utils/markdown.js';

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
  description:
    'Query CDC WONDER for national US mortality statistics — deaths, population, and crude/age-adjusted death rates — from the Underlying Cause of Death database (D76, 1999–2020). Break results out by year, age group, sex, and/or race, and filter by ICD-10 cause of death, sex, age group, or year range. WONDER is a separate CDC system from the Socrata datasets the other cdc_* tools query. Data is national only — sub-national (state/county) breakdowns are not available through the API (CDC vital-statistics policy). Cause of death is a filter, not a grouping. Some measure cells come back as a CDC status token rather than a number — "Suppressed" (withheld for confidentiality), "Unreliable" (a rate from fewer than 20 deaths), or "Not Applicable" (no population denominator); those cells read null in rows and each one is listed in cellNotes with its token. The API is rate-limited to one request every ~15 seconds, so requests may be briefly spaced.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'WONDER rejected the request — e.g. an unknown ICD-10 code, or a filter/grouping combination it does not allow.',
      recovery:
        'Read the returned message, correct the cause_icd10 code or the grouping/filter combination, and retry.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Requests were made less than 15 seconds apart and WONDER returned 429.',
      retryable: true,
      recovery: 'Wait at least 15 seconds between WONDER queries, then retry.',
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
    group_by: z
      .array(z.enum(WONDER_GROUP_BY))
      .min(1)
      .max(4)
      .default(['year'])
      .describe(
        'Dimensions to break results out by (1–4), in output-column order — e.g. ["year"], ["year","sex"], ["age_group","race"]. Results are always national. Cause of death is a filter (cause_icd10), not a grouping.',
      ),
    cause_icd10: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^[A-Z][0-9]{2}(\.[0-9]+)?(-[A-Z][0-9]{2}(\.[0-9]+)?)?$/)
          .describe(
            'ICD-10 underlying-cause code or chapter range. Ranges must match WONDER chapter boundaries exactly (an invalid code is rejected and named in the error) — valid examples: "A00-B99" (infectious), "C00-C97" (malignant neoplasms), "I00-I99" (circulatory), "J00-J98" (respiratory), "V01-Y89" (external causes), or a single code like "I21".',
          ),
      ])
      .optional()
      .describe('Filter to a specific ICD-10 underlying cause of death. Omit for all causes.'),
    sex: z.enum(['all', 'male', 'female']).default('all').describe('Filter by sex.'),
    age_groups: z
      .array(z.enum(WONDER_AGE_GROUPS))
      .optional()
      .describe(
        'Restrict to deaths in any of the listed ten-year age groups — e.g. ["25-34","35-44"] covers both. "1" is the under-1-year group. Omit for all ages.',
      ),
    year_range: z
      .object({
        from: z.number().int().min(1999).max(2020).describe('First year (1999–2020).'),
        to: z.number().int().min(1999).max(2020).describe('Last year (1999–2020).'),
      })
      .refine((r) => r.from <= r.to, { message: 'from must be less than or equal to to' })
      .optional()
      .describe('Inclusive year range within 1999–2020. Omit for all years.'),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
      .describe(
        'Result rows. Each carries the requested group-by dimensions plus deaths, population, crude_rate, and age_adjusted_rate (per 100,000) when age standardization is possible — it is omitted when age_group is a grouping dimension or age_groups selects a single group. A measure cell CDC returned as a status token instead of a number is null here; cellNotes names the cell and the token.',
      ),
    rowCount: z.number().describe('Number of rows returned.'),
    database: z
      .string()
      .describe('WONDER database queried (D76 — Underlying Cause of Death, 1999–2020).'),
    caveats: z
      .array(z.string())
      .describe(
        'CDC-provided caveats and footnotes: data revisions, population-estimate sources, suppression and rate-reliability rules.',
      ),
    cellNotes: z
      .array(
        z
          .object({
            row: z.number().describe('Zero-based index into rows.'),
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
        'One entry per measure cell CDC returned as a status token rather than a number. Those cells read null in rows, so this is what tells a withheld value apart from an unreliable one or a genuinely absent one.',
      ),
    suppressedCount: z
      .number()
      .describe(
        'How many cellNotes carry the "Suppressed" token — cells CDC withheld for confidentiality.',
      ),
  }),

  // Agent-facing result context: a summary of the grouping and filters applied (for
  // reproducibility) and a notice when nothing matched or CDC replaced values with a token.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Human-readable summary of the grouping and filters sent to WONDER.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no rows matched, and a note when CDC returned a status token in place of a measure value.',
      ),
  },

  async handler(input, ctx) {
    const options: WonderQueryOptions = {
      groupBy: input.group_by,
      ...(input.cause_icd10 ? { causeIcd10: input.cause_icd10 } : {}),
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
      input.cause_icd10 ? `cause ${input.cause_icd10}` : undefined,
      input.sex !== 'all' ? `sex ${input.sex}` : undefined,
      input.age_groups?.length ? `ages ${input.age_groups.join(',')}` : undefined,
      input.year_range ? `years ${input.year_range.from}–${input.year_range.to}` : undefined,
    ].filter(Boolean);
    const effectiveQuery = `${WONDER_DATABASE_NAME} · grouped by ${input.group_by.join(', ')}${
      filters.length ? ` · filtered by ${filters.join(', ')}` : ''
    }`;
    ctx.enrich({ effectiveQuery });

    const notices: string[] = [];
    if (result.rowCount === 0) {
      notices.push(
        'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
      );
    }
    if (result.suppressedCount > 0) {
      notices.push(
        `${result.suppressedCount} cell(s) were withheld by CDC for confidentiality (Suppressed) and are null. Aggregate over more years or a broader cause/age range to reduce suppression.`,
      );
    }
    const otherTokens = tallyOtherTokens(result.cellNotes);
    if (otherTokens.length > 0) {
      notices.push(
        `CDC returned a status token instead of a number for some cells — ${otherTokens.join('; ')}. Those cells are null but were not withheld; cellNotes gives the row index and column of each.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('WONDER query executed', {
      groupBy: input.group_by,
      rowCount: result.rowCount,
      cellNoteCount: result.cellNotes.length,
      suppressedCount: result.suppressedCount,
    });

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      database: result.database,
      caveats: result.caveats,
      cellNotes: result.cellNotes,
      suppressedCount: result.suppressedCount,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const firstRow = result.rows[0];

    if (firstRow) {
      const columns = Object.keys(firstRow);
      // A cell CDC replaced with a status token is null in `rows`; render the token in its
      // place so a content[]-only client can tell it apart from a blank cell.
      const tokenAt = new Map(result.cellNotes.map((n) => [`${n.row}:${n.column}`, n.token]));
      lines.push(
        `**${result.database} — ${result.rowCount} rows**`,
        '',
        `| ${columns.join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
      );
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
    } else {
      lines.push(
        'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
      );
    }

    if (result.caveats.length > 0) {
      lines.push('', '**Caveats:**', ...result.caveats.map((c) => `- ${c}`));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
