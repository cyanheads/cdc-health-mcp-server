/**
 * @fileoverview Tests for cdc://datasets/{datasetId} resource.
 * @module tests/mcp-server/resources/definitions/dataset-detail
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';

const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ getMetadata: mockGetMetadata }),
}));

const sampleMetadata: DatasetMetadata = {
  name: 'Diabetes Mortality',
  description: 'State-level diabetes death rates',
  rowCount: 50000,
  updatedAt: '2024-06-01T00:00:00.000Z',
  columns: [
    { fieldName: 'state', dataType: 'text', description: 'US state name' },
    { fieldName: 'year', dataType: 'number', description: 'Data year' },
  ],
};

describe('cdc://datasets/{datasetId}', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns metadata for a valid dataset ID', async () => {
    mockGetMetadata.mockResolvedValue(sampleMetadata);
    const ctx = createMockContext();
    const params = datasetDetailResource.params!.parse({ datasetId: 'bi63-dtpu' });
    const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

    expect(result.name).toBe('Diabetes Mortality');
    expect(result.rowCount).toBe(50000);
    expect(result.columns).toHaveLength(2);
    expect(mockGetMetadata).toHaveBeenCalledWith('bi63-dtpu', ctx.signal);
  });

  it('rejects invalid dataset ID in params schema', () => {
    expect(() => datasetDetailResource.params!.parse({ datasetId: 'bad-id!' })).toThrow();
  });

  it('propagates service errors', async () => {
    mockGetMetadata.mockRejectedValue(new Error('Dataset not found'));
    const ctx = createMockContext();
    const params = datasetDetailResource.params!.parse({ datasetId: 'bi63-dtpu' });
    await expect(datasetDetailResource.handler(params, ctx)).rejects.toThrow(/not found/);
  });
});
