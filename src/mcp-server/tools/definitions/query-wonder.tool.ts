/**
 * @fileoverview Tool to query CDC WONDER national mortality statistics (database D76).
 * @module mcp-server/tools/definitions/query-wonder
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  WONDER_AGE_GROUPS,
  WONDER_DATABASE_NAME,
  WONDER_GROUP_BY,
  type WonderQueryOptions,
  type WonderResult,
} from '@/services/wonder/types.js';
import { getWonderService } from '@/services/wonder/wonder-service.js';

export const queryWonder = tool('cdc_query_wonder', {
  description:
    'Query CDC WONDER for national US mortality statistics — deaths, population, and crude/age-adjusted death rates — from the Underlying Cause of Death database (D76, 1999–2020). Break results out by year, age group, sex, and/or race, and filter by ICD-10 cause of death, sex, age group, or year range. WONDER is a separate CDC system from the Socrata datasets the other cdc_* tools query. Data is national only — sub-national (state/county) breakdowns are not available through the API (CDC vital-statistics policy). Cause of death is a filter, not a grouping. CDC suppresses any cell with fewer than 10 deaths (returned as null). The API is rate-limited to one request every ~15 seconds, so requests may be briefly spaced.',
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
        'Restrict to specific ten-year age groups — e.g. ["25-34","35-44"]. "1" is the under-1-year group. Omit for all ages.',
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
        'Result rows. Each carries the requested group-by dimensions plus deaths, population, crude_rate, and — unless grouped by age_group — age_adjusted_rate (per 100,000). Suppressed measure cells (< 10 deaths) are null.',
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
    suppressedCount: z
      .number()
      .describe('Number of measure cells CDC suppressed (< 10 deaths), returned as null.'),
  }),

  // Agent-facing result context: a summary of the grouping and filters applied (for
  // reproducibility) and a notice when nothing matched or cells were suppressed.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Human-readable summary of the grouping and filters sent to WONDER.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no rows matched, or a note that CDC suppressed some cells.'),
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

    if (result.rowCount === 0) {
      ctx.enrich.notice(
        'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
      );
    } else if (result.suppressedCount > 0) {
      ctx.enrich.notice(
        `${result.suppressedCount} cell(s) were suppressed by CDC (fewer than 10 deaths) and returned as null. Aggregate over more years or a broader cause/age range to reduce suppression.`,
      );
    }

    ctx.log.info('WONDER query executed', {
      groupBy: input.group_by,
      rowCount: result.rowCount,
      suppressedCount: result.suppressedCount,
    });

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      database: result.database,
      caveats: result.caveats,
      suppressedCount: result.suppressedCount,
    };
  },

  format: (result) => {
    if (!result.rows[0]) {
      return [
        {
          type: 'text',
          text: 'No rows matched. Broaden the filters (cause_icd10, sex, age_groups, year_range) or confirm the ICD-10 code covers the years selected.',
        },
      ];
    }

    const columns = Object.keys(result.rows[0]);
    const lines = [
      `**${result.database} — ${result.rowCount} rows**`,
      '',
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
    ];
    for (const row of result.rows) {
      const cells = columns.map((c) => {
        const v = row[c];
        return (v == null ? '' : String(v)).replaceAll('|', '\\|');
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }

    if (result.suppressedCount > 0) {
      lines.push(
        '',
        `_${result.suppressedCount} cell(s) suppressed by CDC (< 10 deaths), shown as blank._`,
      );
    }
    if (result.caveats.length > 0) {
      lines.push('', '**Caveats:**', ...result.caveats.slice(0, 8).map((c) => `- ${c}`));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
