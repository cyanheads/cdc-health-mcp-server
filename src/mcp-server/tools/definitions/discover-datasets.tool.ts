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
      .max(9999)
      .default(0)
      .describe('Pagination offset for browsing beyond first page (max 9999).'),
  }),

  output: z.object({
    datasets: z
      .array(
        z
          .object({
            id: z.string().describe('Four-by-four dataset identifier (e.g., "bi63-dtpu").'),
            name: z.string().describe('Dataset name.'),
            description: z
              .string()
              .optional()
              .describe('Dataset description when provided by the catalog.'),
            category: z.string().optional().describe('Domain category when provided.'),
            tags: z.array(z.string()).optional().describe('Domain tags when provided.'),
            columnNames: z
              .array(z.string())
              .optional()
              .describe('Available column field names when provided.'),
            columnTypes: z
              .array(z.string())
              .optional()
              .describe('Column data types (parallel to columnNames) when provided.'),
            updatedAt: z.string().optional().describe('Last data update timestamp when provided.'),
            pageViews: z.number().optional().describe('Total page views when provided.'),
          })
          .describe('A single dataset catalog entry.'),
      )
      .describe('Matching datasets.'),
    totalCount: z.number().describe('Total matching datasets (for pagination).'),
    appliedFilters: z
      .object({
        query: z.string().optional().describe('Search query used.'),
        category: z.string().optional().describe('Category filter used.'),
        tags: z.array(z.string()).optional().describe('Tag filters used.'),
      })
      .describe('Filters applied to this search (echoed for diagnostics).'),
  }),

  async handler(input, ctx) {
    const service = getSocrataService();
    const result = await service.discover(input, ctx.signal);

    ctx.log.info('Dataset discovery completed', {
      query: input.query,
      category: input.category,
      resultCount: result.datasets.length,
      totalCount: result.totalCount,
    });

    return {
      ...result,
      appliedFilters: {
        ...(input.query ? { query: input.query } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
      },
    };
  },

  format: (result) => {
    const filters = result.appliedFilters;
    const filterParts: string[] = [];
    if (filters.query) filterParts.push(`query "${filters.query}"`);
    if (filters.category) filterParts.push(`category "${filters.category}"`);
    if (filters.tags?.length) filterParts.push(`tags [${filters.tags.join(', ')}]`);

    if (result.datasets.length === 0) {
      const criteria = filterParts.length > 0 ? ` for ${filterParts.join(', ')}` : '';

      return [
        {
          type: 'text',
          text: `No datasets found${criteria}. Try broader search terms, different keywords, or remove category/tag filters. Browse all datasets by calling with no parameters.`,
        },
      ];
    }

    const filterSuffix = filterParts.length > 0 ? ` — filtered by ${filterParts.join(', ')}` : '';

    const lines = [
      `**${result.totalCount} datasets found** (showing ${result.datasets.length})${filterSuffix}\n`,
    ];
    for (const d of result.datasets) {
      lines.push(`### ${d.name}`);
      const views = typeof d.pageViews === 'number' ? d.pageViews.toLocaleString() : '—';
      lines.push(
        `**ID:** \`${d.id}\` | **Category:** ${d.category ?? '—'} | **Updated:** ${d.updatedAt ?? '—'} | **Views:** ${views}`,
      );
      if (d.description)
        lines.push(d.description.slice(0, 300) + (d.description.length > 300 ? '...' : ''));
      if (d.tags && d.tags.length > 0) lines.push(`**Tags:** ${d.tags.join(', ')}`);
      if (d.columnNames && d.columnNames.length > 0) {
        const columns = d.columnNames
          .map((name, i) => `\`${name}\` (${d.columnTypes?.[i] ?? 'unknown'})`)
          .join(', ');
        lines.push(`**Columns:** ${columns}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
