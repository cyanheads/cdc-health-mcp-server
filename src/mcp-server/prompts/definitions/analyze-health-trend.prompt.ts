/**
 * @fileoverview Prompt for guided investigation of public health questions across CDC data.
 * @module mcp-server/prompts/definitions/analyze-health-trend
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const analyzeHealthTrend = prompt('analyze_health_trend', {
  description:
    'Structured workflow for investigating a public health question across CDC data. Guides through: discover relevant datasets, inspect schemas, query for baseline data, compare across time/geography/demographics, and synthesize findings.',
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
        'Geographic scope — "national", a specific state name, or "all states" for comparison. Defaults to national.',
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
            'Follow this workflow:',
            '',
            '1. **Discover** — Use `cdc_discover_datasets` to find relevant datasets. Try multiple search terms if the first query is too narrow. Note dataset IDs, update dates, and which look most promising.',
            '',
            '2. **Inspect** — Use `cdc_get_dataset_schema` on the top 2-3 candidates. Check column names, types, and what filtering dimensions are available (year, state, demographic breakdowns, etc.).',
            '',
            '3. **Baseline** — Query the most relevant dataset for an initial picture. Start broad, then narrow. Check what years, states, and categories are actually present in the data.',
            '',
            '4. **Compare** — Look for trends over time, geographic variation, or demographic disparities depending on what the data supports. Use aggregation (GROUP BY) for summaries.',
            '',
            '5. **Synthesize** — Summarize findings with specific numbers. Note:',
            '   - Data limitations (suppressed counts, missing years, reporting changes)',
            '   - Whether the dataset is still being updated or is historical',
            '   - Caveats about confounders or reporting methodology',
            '   - Suggestions for further investigation',
          ].join('\n'),
        },
      },
    ];
  },
});
