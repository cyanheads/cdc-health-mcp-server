/**
 * @fileoverview Prompt for guided investigation of public health questions across CDC data.
 * The generated text routes the question between CDC WONDER and the Socrata catalog by naming
 * the conditions each covers. That branch is guidance for the reader, deliberately not a topic
 * classification performed here — the message is the same whatever the topic argument says.
 * @module mcp-server/prompts/definitions/analyze-health-trend
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const analyzeHealthTrend = prompt('analyze_health_trend', {
  description:
    'Structured workflow for investigating a public health question across CDC data. Picks between the two systems this server reads — CDC WONDER for national 1999–2020 mortality, the Socrata catalog for everything else — then guides through: discover relevant datasets, inspect schemas, query for baseline data, compare across time/geography/demographics, and synthesize findings.',
  args: z.object({
    topic: z
      .string()
      .describe(
        'The health topic or question to investigate (e.g., "diabetes mortality trends by state", "childhood vaccination coverage over time").',
      ),
    timeRange: z
      .string()
      .optional()
      .describe(
        'Time period of interest (e.g., "2015-2023", "last 10 years"). Defaults to all available years.',
      ),
    geography: z
      .string()
      .optional()
      .describe(
        'Geographic scope — "national", a specific state name (e.g., "California"), or "all states" for comparison. Defaults to national.',
      ),
  }),
  generate: (args) => {
    const timeContext = args.timeRange ? ` Focus on the period ${args.timeRange}.` : '';
    const geoContext = args.geography
      ? ` Geographic scope: ${args.geography}.`
      : ' Start at the national level.';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Investigate this public health question using CDC data: **${args.topic}**${timeContext}${geoContext}`,
            '',
            'This server reads two separate CDC systems. Settle which one answers the question before running any query:',
            '',
            '- `cdc_query_wonder` — CDC WONDER, Underlying Cause of Death. Use it when the question is about deaths and meets all three conditions: national scope, years within 1999–2020, and a cause expressible as an ICD-10 code or chapter range. It reports deaths, population, crude rate, and — where age can be standardized — age-adjusted rate. It has no sub-national breakdown and holds nothing after 2020.',
            '- `cdc_discover_datasets` → `cdc_get_dataset_schema` → `cdc_query_dataset` — the Socrata catalog. Use it for whatever those conditions rule out: state or county detail, years after 2020, and any non-mortality topic such as vaccination coverage, behavioral risk factors, notifiable-disease surveillance, or environmental measures.',
            '',
            'A question that needs both — a national mortality series alongside a state breakdown — takes both paths. Attribute every number to the system it came from: WONDER and the Socrata mortality datasets are compiled differently, so their totals need not agree.',
            '',
            'Follow this workflow:',
            '',
            '1. **Discover** — Socrata path: use `cdc_discover_datasets` to find relevant datasets. Try multiple search terms if the first query is too narrow. Note dataset IDs, update dates, and which look most promising; pass over any entry whose `columnCount` is 0, which marks a non-tabular asset the query tools cannot read. WONDER path: there is nothing to discover — `cdc_query_wonder` is the whole surface — so go straight to step 3.',
            '',
            '2. **Inspect** — Socrata path: use `cdc_get_dataset_schema` on the top 2-3 candidates. Check column names, types, and what filtering dimensions are available (year, state, demographic breakdowns, etc.). WONDER path: the shape is fixed — break results out by `year`, `age_group`, `sex`, and `race`; narrow with `cause_icd10`, `sex`, `age_groups`, and `year_range`.',
            '',
            '3. **Baseline** — Socrata path: use `cdc_query_dataset` against the most relevant dataset for an initial picture. Start broad, then narrow. Check what years, states, and categories are actually present in the data. WONDER path: start with `group_by` set to `year` and the cause and years in scope, then add dimensions.',
            '',
            '4. **Compare** — Look for trends over time, geographic variation, or demographic disparities depending on what the source supports. Socrata datasets aggregate (GROUP BY) over whatever geographic and demographic columns the schema exposes. WONDER breaks out by adding `sex`, `race`, or `age_group` to `group_by`, and cannot go below the national level whatever the question asks for.',
            '',
            '5. **Synthesize** — Summarize findings with specific numbers. Note:',
            '   - Data limitations (suppressed counts, missing years, reporting changes). A WONDER measure cell CDC withheld or flagged reads null in `rows` and is named in `cellNotes` with its token',
            '   - Whether the dataset is still being updated or is historical',
            '   - Caveats about confounders or reporting methodology, including the `caveats` WONDER returns with each result',
            '   - Suggestions for further investigation',
          ].join('\n'),
        },
      },
    ];
  },
});
