/**
 * @fileoverview Edge-case tests for cdc://datasets/{datasetId} resource.
 * @module tests/mcp-server/resources/definitions/dataset-detail-edge
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';

const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ getMetadata: mockGetMetadata }),
}));

describe('cdc://datasets/{datasetId} — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('params schema validation', () => {
    it('rejects ID with uppercase letters', () => {
      expect(() => datasetDetailResource.params!.parse({ datasetId: 'AB12-cd34' })).toThrow();
    });

    it('rejects ID with special characters', () => {
      expect(() => datasetDetailResource.params!.parse({ datasetId: 'ab12-cd3!' })).toThrow();
    });

    it('rejects ID that is too short', () => {
      expect(() => datasetDetailResource.params!.parse({ datasetId: 'ab12-cd3' })).toThrow();
    });

    it('rejects path traversal attempt', () => {
      expect(() => datasetDetailResource.params!.parse({ datasetId: '../etc/passwd' })).toThrow();
    });

    it('accepts all-numeric four-by-four', () => {
      const params = datasetDetailResource.params!.parse({ datasetId: '1234-5678' });
      expect(params.datasetId).toBe('1234-5678');
    });
  });

  describe('handler — sparse metadata', () => {
    it('returns sparse metadata (no rowCount, no updatedAt, no description)', async () => {
      const sparseMetadata: DatasetMetadata = {
        name: 'Sparse',
        columns: [{ fieldName: 'id', dataType: 'text' }],
      };
      mockGetMetadata.mockResolvedValue(sparseMetadata);
      const ctx = createMockContext();
      const params = datasetDetailResource.params!.parse({ datasetId: 'ab12-cd34' });
      const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

      expect(result.name).toBe('Sparse');
      expect(result.rowCount).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
      expect(result.description).toBeUndefined();
    });

    it('passes dataset ID to service correctly', async () => {
      const meta: DatasetMetadata = { name: 'Test', columns: [] };
      mockGetMetadata.mockResolvedValue(meta);
      const ctx = createMockContext();
      const params = datasetDetailResource.params!.parse({ datasetId: 'zz99-ww88' });
      await datasetDetailResource.handler(params, ctx);
      expect(mockGetMetadata).toHaveBeenCalledWith('zz99-ww88', ctx.signal);
    });
  });

  describe('list()', () => {
    it('returns example dataset URIs', async () => {
      const listing = await datasetDetailResource.list!();
      expect(listing.resources.length).toBeGreaterThan(0);
      for (const r of listing.resources) {
        expect(r.uri).toMatch(/^cdc:\/\/datasets\/[a-z0-9]{4}-[a-z0-9]{4}$/);
      }
    });
  });
});
