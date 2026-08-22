/**
 * @fileoverview Edge-case tests for cdc://datasets resource.
 * @module tests/mcp-server/resources/definitions/datasets-edge
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import type { DiscoverResult } from '@/services/socrata/types.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ discover: mockDiscover }),
}));

/**
 * `list()` receives the SDK's server context, not a handler Context, and this
 * listing ignores it. The stub carries the members the type requires and
 * rejects on every server-to-client call so an accidental use is loud.
 */
type ListExtra = Parameters<NonNullable<typeof datasetsResource.list>>[0];

const unused = () => Promise.reject(new Error('list() must not call the client'));

function makeListExtra(): ListExtra {
  return {
    mcpReq: {
      id: 1,
      method: 'resources/list',
      signal: new AbortController().signal,
      requestState: () => undefined,
      send: unused,
      notify: () => Promise.resolve(),
      log: () => Promise.resolve(),
      elicitInput: unused,
      requestSampling: unused,
    },
  };
}

describe('cdc://datasets — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('propagates service errors', async () => {
    mockDiscover.mockRejectedValue(new Error('Catalog unavailable (503)'));
    const ctx = createMockContext({ errors: datasetsResource.errors });
    await expect(datasetsResource.handler({}, ctx)).rejects.toThrow(/Catalog unavailable/);
  });

  it('returns empty datasets when service returns none', async () => {
    mockDiscover.mockResolvedValue({ datasets: [], totalCount: 0 });
    const ctx = createMockContext({ errors: datasetsResource.errors });
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
    const ctx = createMockContext({ errors: datasetsResource.errors });
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
    const ctx = createMockContext({ errors: datasetsResource.errors });
    const result = (await datasetsResource.handler({}, ctx)) as {
      datasets: Record<string, unknown>[];
    };
    expect(result.datasets[0]?.category).toBeUndefined();
  });

  it('list() returns the static listing entry', async () => {
    const listing = await datasetsResource.list!(makeListExtra());
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]?.uri).toBe('cdc://datasets');
  });

  describe('handler — service error re-throw with recovery', () => {
    it('surfaces recovery.hint and strips raw url/status/body on a reason-tagged McpError', async () => {
      const serviceErr = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Socrata returned HTTP 503 Service Unavailable.',
        {
          reason: 'upstream_error',
          url: 'http://127.0.0.1:39991/api/catalog/v1?domains=data.cdc.gov&limit=50&offset=0',
          status: 503,
          statusText: 'Service Unavailable',
          body: 'catalog unavailable from test stub',
        },
      );
      mockDiscover.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: datasetsResource.errors });

      const err = (await Promise.resolve(datasetsResource.handler({}, ctx)).catch(
        (e: unknown) => e,
      )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.data).toMatchObject({
        reason: 'upstream_error',
        recovery: { hint: expect.stringContaining('catalog may be temporarily unavailable') },
      });
      // Raw upstream/debug fields must not leak through the resource error payload.
      expect(err.data?.url).toBeUndefined();
      expect(err.data?.status).toBeUndefined();
      expect(err.data?.statusText).toBeUndefined();
      expect(err.data?.body).toBeUndefined();
    });

    it('preserves a declared rate_limited reason with its recovery hint', async () => {
      const serviceErr = new McpError(
        JsonRpcErrorCode.RateLimited,
        'Rate limited by Socrata API (429).',
        { reason: 'rate_limited', url: 'http://127.0.0.1:39991/api/catalog/v1' },
      );
      mockDiscover.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: datasetsResource.errors });

      await expect(datasetsResource.handler({}, ctx)).rejects.toMatchObject({
        data: expect.objectContaining({
          reason: 'rate_limited',
          recovery: { hint: expect.stringContaining('rate-limited') },
        }),
      });
    });
  });
});
