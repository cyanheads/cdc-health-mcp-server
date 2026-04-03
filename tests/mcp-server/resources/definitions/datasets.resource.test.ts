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

  it('calls discover with limit 50', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
    await datasetsResource.handler({}, ctx);

    expect(mockDiscover).toHaveBeenCalledWith({ limit: 50 }, ctx.signal);
  });
});
