/**
 * @fileoverview Tests for cdc://datasets resource.
 * @module tests/mcp-server/resources/definitions/datasets
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ discover: mockDiscover }),
}));

describe('cdc://datasets', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns simplified dataset listing', async () => {
    mockDiscover.mockResolvedValue({
      datasets: [
        {
          id: 'bi63-dtpu',
          name: 'Diabetes Mortality',
          description: 'Description',
          category: 'NCHS',
          tags: ['diabetes'],
          columnNames: ['state'],
          columnTypes: ['text'],
          updatedAt: '2024-01-15T00:00:00.000Z',
          pageViews: 5000,
        },
      ],
      totalCount: 1,
    });

    const ctx = createMockContext();
    const result = (await datasetsResource.handler({}, ctx)) as {
      datasets: { id: string; name: string; category: string; updatedAt: string }[];
      totalCount: number;
    };

    expect(result.totalCount).toBe(1);
    expect(result.datasets).toHaveLength(1);
    expect(result.datasets[0]).toMatchObject({
      id: 'bi63-dtpu',
      name: 'Diabetes Mortality',
      category: 'NCHS',
    });
    /* Should NOT include full details like description, tags, columns */
    expect(result.datasets[0]).not.toHaveProperty('description');
    expect(result.datasets[0]).not.toHaveProperty('tags');
  });

  it('labels non-tabular entries so an orientation read does not pick one', async () => {
    /**
     * The orientation page is drawn from the same catalog as cdc_discover_datasets and
     * carries charts and stories among the datasets — 3 of the live top 50. Without the
     * type and the column count they are indistinguishable here, and the ID only fails
     * one call later, at cdc_get_dataset_schema.
     */
    mockDiscover.mockResolvedValue({
      datasets: [
        { id: 'bi63-dtpu', name: 'Leading Causes', assetType: 'dataset', columnNames: ['state'] },
        { id: 'sxbq-3sid', name: 'Pfizer Allocations', assetType: 'chart', columnNames: [] },
        { id: 's2qv-b27b', name: 'DHDS', assetType: 'filter', columnNames: ['year', 'state'] },
      ],
      totalCount: 3,
    });

    const ctx = createMockContext();
    const result = (await datasetsResource.handler({}, ctx)) as {
      datasets: { id: string; assetType?: string; columnCount?: number }[];
    };

    expect(result.datasets.map((d) => [d.id, d.assetType, d.columnCount])).toEqual([
      ['bi63-dtpu', 'dataset', 1],
      ['sxbq-3sid', 'chart', 0],
      // A `filter` entry has real columns and queries normally — the type alone would hide it.
      ['s2qv-b27b', 'filter', 2],
    ]);
  });

  it('calls discover with limit 50', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
    await datasetsResource.handler({}, ctx);

    expect(mockDiscover).toHaveBeenCalledWith({ limit: 50 }, ctx.signal);
  });
});
