/**
 * @fileoverview Tool to search the CDC dataset catalog by keyword, category, or tag.
 * @module mcp-server/tools/definitions/discover-datasets
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

const AppliedFiltersSchema = z.object({
  query: z.string().optional().describe('Search query used.'),
  category: z.string().optional().describe('Category filter used.'),
  tags: z.array(z.string()).optional().describe('Tag filters used.'),
});

export const discoverDatasets = tool('cdc_discover_datasets', {
  description:
    'Search the CDC dataset catalog by keyword, category, or tag. Returns dataset IDs, names, descriptions, column lists, and update timestamps.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Socrata API returns 429 Too Many Requests.',
      retryable: true,
      recovery: 'Retry after a brief delay; the request was rate-limited.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Socrata catalog API returned a non-success status outside of 400/404/429.',
      retryable: true,
      recovery: 'Retry after a brief delay; the catalog may be temporarily unavailable.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Catalog API returned 400 — typically a malformed query or invalid filter value.',
      recovery:
        'Check that category names and tag values match what the catalog accepts; try removing filters to confirm basic discovery works.',
    },
  ],

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
            name: z
              .string()
              .describe(
                'Dataset display name from the catalog (e.g., "Provisional COVID-19 Deaths by Sex and Age").',
              ),
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
  }),

  // Agent-facing result-set context: total for pagination, the filters as the server
  // applied them, and a recovery notice when nothing matched. Reaches structuredContent
  // AND content[] automatically — no format() entry needed or allowed.
  enrichment: {
    totalCount: z.number().describe('Total matching datasets in the catalog (for pagination).'),
    appliedFilters: AppliedFiltersSchema.describe(
      'Filters applied to this query; absent fields indicate no filter on that dimension.',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no datasets matched — echoes the applied filters and suggests how to broaden the search.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Matching' },
    appliedFilters: {
      render: (f) => {
        const parts: string[] = [];
        if (f.query) parts.push(`- **Query:** "${f.query}"`);
        if (f.category) parts.push(`- **Category:** "${f.category}"`);
        if (f.tags?.length) parts.push(`- **Tags:** ${f.tags.join(', ')}`);
        return parts.length > 0
          ? `**Applied Filters:**\n${parts.join('\n')}`
          : '**Applied Filters:** none';
      },
    },
  },

  async handler(input, ctx) {
    const service = getSocrataService();
    let result: DiscoverResult;
    try {
      result = await service.discover(input, ctx.signal);
    } catch (err) {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        throw ctx.fail(reason, err.message, { ...ctx.recoveryFor(reason) });
      }
      throw err;
    }

    const appliedFilters = {
      ...(input.query ? { query: input.query } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
    };

    ctx.enrich({ totalCount: result.totalCount, appliedFilters });

    if (result.datasets.length === 0) {
      const filterParts: string[] = [];
      if (input.query) filterParts.push(`query "${input.query}"`);
      if (input.category) filterParts.push(`category "${input.category}"`);
      if (input.tags?.length) filterParts.push(`tags [${input.tags.join(', ')}]`);
      const criteria = filterParts.length > 0 ? ` for ${filterParts.join(', ')}` : '';
      ctx.enrich.notice(
        `No datasets found${criteria}. Try broader search terms, different keywords, or remove category/tag filters. Browse all datasets by calling with no parameters.`,
      );
    }

    ctx.log.info('Dataset discovery completed', {
      query: input.query,
      category: input.category,
      resultCount: result.datasets.length,
      totalCount: result.totalCount,
    });

    return { datasets: result.datasets };
  },

  format: (result) => {
    if (result.datasets.length === 0) {
      return [
        {
          type: 'text',
          text: 'No datasets matched the search criteria.',
        },
      ];
    }

    const lines: string[] = [`**${result.datasets.length} datasets returned**\n`];
    for (const d of result.datasets) {
      lines.push(`### ${d.name}`);
      const views = typeof d.pageViews === 'number' ? d.pageViews.toLocaleString() : '—';
      lines.push(
        `**ID:** \`${d.id}\` | **Category:** ${d.category ?? '—'} | **Updated:** ${d.updatedAt ?? '—'} | **Views:** ${views}`,
      );
      if (d.description) lines.push(d.description);
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
