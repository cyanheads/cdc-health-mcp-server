/**
 * @fileoverview Edge-case tests for cdc://datasets resource.
 * @module tests/mcp-server/resources/definitions/datasets-edge
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ discover: mockDiscover }),
}));

describe('cdc://datasets — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('propagates service errors', async () => {
    mockDiscover.mockRejectedValue(new Error('Catalog unavailable (503)'));
    const ctx = createMockContext();
    await expect(datasetsResource.handler({}, ctx)).rejects.toThrow(/Catalog unavailable/);
  });

  it('returns empty datasets when service returns none', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext();
    const result = (await datasetsResource.handler({}, ctx)) as {
      datasets: unknown[];
      totalCount: number;
    };
    expect(result.datasets).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('omits description, tags, and columns from each entry', async () => {
    mockDiscover.mockResolvedValue({
      datasets: [
        {
          id: 'ab12-cd34',
          name: 'Full Dataset',
          description: 'Should be stripped',
          category: 'NCHS',
          tags: ['test', 'tag'],
          columnNames: ['col1'],
          columnTypes: ['text'],
          updatedAt: '2024-01-01T00:00:00.000Z',
          pageViews: 100,
        },
      ],
      totalCount: 1,
    });
    const ctx = createMockContext();
    const result = (await datasetsResource.handler({}, ctx)) as {
      datasets: Record<string, unknown>[];
    };

    expect(result.datasets[0]).not.toHaveProperty('description');
    expect(result.datasets[0]).not.toHaveProperty('tags');
    expect(result.datasets[0]).not.toHaveProperty('columnNames');
    expect(result.datasets[0]).not.toHaveProperty('columnTypes');
    expect(result.datasets[0]).not.toHaveProperty('pageViews');
  });

  it('preserves undefined category in output (not an error)', async () => {
    mockDiscover.mockResolvedValue({
      datasets: [
        {
          id: 'ab12-cd34',
          name: 'No Category',
          // no category
        },
      ],
      totalCount: 1,
    });
    const ctx = createMockContext();
    const result = (await datasetsResource.handler({}, ctx)) as {
      datasets: Record<string, unknown>[];
    };
    expect(result.datasets[0].category).toBeUndefined();
  });

  it('list() returns the static listing entry', async () => {
    const listing = await datasetsResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0].uri).toBe('cdc://datasets');
  });
});
