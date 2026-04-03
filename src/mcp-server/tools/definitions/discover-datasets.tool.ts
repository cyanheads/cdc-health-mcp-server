/**
 * @fileoverview Tool to search the CDC dataset catalog by keyword, category, or tag.
 * @module mcp-server/tools/definitions/discover-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const discoverDatasets = tool('cdc_discover_datasets', {
  description:
    'Search the CDC dataset catalog by keyword, category, or tag. Returns dataset IDs, names, descriptions, column lists, and update timestamps. Use this first to find the right dataset before querying.',
  annotations: { readOnlyHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search across dataset names and descriptions (e.g., "diabetes mortality", "lead exposure children").',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Filter by domain category (e.g., "NNDSS", "Vaccinations", "Behavioral Risk Factors").',
      ),
    tags: z
      .array(z.string().describe('Tag value'))
      .optional()
      .describe('Filter by domain tags (e.g., ["covid19", "surveillance"]).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Results to return (default 10, max 100).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Pagination offset for browsing beyond first page.'),
  }),

  output: z.object({
    datasets: z
      .array(
        z.object({
          id: z.string().describe('Four-by-four dataset identifier (e.g., "bi63-dtpu").'),
          name: z.string().describe('Dataset name.'),
          description: z.string().describe('Dataset description.'),
          category: z.string().describe('Domain category.'),
          tags: z.array(z.string().describe('Tag')).describe('Domain tags.'),
          columnNames: z
            .array(z.string().describe('Column name'))
            .describe('Available column field names.'),
          columnTypes: z
            .array(z.string().describe('Column type'))
            .describe('Column data types (parallel to columnNames).'),
          updatedAt: z.string().describe('Last data update timestamp.'),
          pageViews: z.number().describe('Total page views.'),
        }),
      )
      .describe('Matching datasets.'),
    totalCount: z.number().describe('Total matching datasets (for pagination).'),
  }),

  async handler(input, ctx) {
    const service = getSocrataService();
    const result = await service.discover(
      {
        query: input.query,
        category: input.category,
        tags: input.tags,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.signal,
    );

    ctx.log.info('Dataset discovery completed', {
      query: input.query,
      category: input.category,
      resultCount: result.datasets.length,
      totalCount: result.totalCount,
    });

    return result;
  },

  format: (result) => {
    if (result.datasets.length === 0) {
      return [
        {
          type: 'text',
          text: 'No datasets found. Try broadening your search terms or removing filters.',
        },
      ];
    }

    const lines = [`**${result.totalCount} datasets found** (showing ${result.datasets.length})\n`];
    for (const d of result.datasets) {
      lines.push(`### ${d.name}`);
      lines.push(
        `**ID:** \`${d.id}\` | **Category:** ${d.category || '—'} | **Updated:** ${d.updatedAt}`,
      );
      if (d.description)
        lines.push(d.description.slice(0, 300) + (d.description.length > 300 ? '...' : ''));
      if (d.tags.length > 0) lines.push(`**Tags:** ${d.tags.join(', ')}`);
      lines.push(
        `**Columns:** ${d.columnNames.slice(0, 10).join(', ')}${d.columnNames.length > 10 ? ` (+${d.columnNames.length - 10} more)` : ''}`,
      );
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
