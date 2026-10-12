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
    const ctx = createMockContext({ errors: datasetDetailResource.errors });
    const params = datasetDetailResource.params!.parse({ datasetId: 'bi63-dtpu' });
    const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

    expect(result.name).toBe('Diabetes Mortality');
    expect(result.rowCount).toBe(50000);
    expect(result.columns).toHaveLength(2);
    expect(mockGetMetadata).toHaveBeenCalledWith('bi63-dtpu', ctx.signal);
  });

  it('carries the row count and its provenance, matching cdc_get_dataset_schema', async () => {
    /** Both surfaces read the same metadata, so both must disclose which figure it is. */
    mockGetMetadata.mockResolvedValue({
      ...sampleMetadata,
      rowCount: 137_700,
      rowCountSource: 'live',
    });
    const ctx = createMockContext({ errors: datasetDetailResource.errors });
    const params = datasetDetailResource.params!.parse({ datasetId: '9bhg-hcku' });
    const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

    expect(result.rowCount).toBe(137_700);
    expect(result.rowCountSource).toBe('live');
  });

  it('discloses a cached row count rather than presenting it as the dataset total', async () => {
    mockGetMetadata.mockResolvedValue({
      ...sampleMetadata,
      rowCount: 88_128,
      rowCountSource: 'cached',
    });
    const ctx = createMockContext({ errors: datasetDetailResource.errors });
    const params = datasetDetailResource.params!.parse({ datasetId: '9bhg-hcku' });
    const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

    expect(result.rowCount).toBe(88_128);
    expect(result.rowCountSource).toBe('cached');
  });

  it('returns a description under the cap whole, with no cut fields or notice', async () => {
    const description = `${'Long prose. '.repeat(60)}end.`;
    mockGetMetadata.mockResolvedValue({ ...sampleMetadata, description });
    const ctx = createMockContext({ errors: datasetDetailResource.errors });
    const params = datasetDetailResource.params!.parse({ datasetId: 'bi63-dtpu' });
    const result = (await datasetDetailResource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.description).toBe(description);
    expect(result).not.toHaveProperty('descriptionTruncated');
    expect(result).not.toHaveProperty('descriptionLength');
    expect(result).not.toHaveProperty('notice');
  });

  describe('description cap', () => {
    const LONG = `${'Weekly hospital respiratory reporting. '.repeat(830)}End of notes.`;
    const descriptionNotice =
      'The dataset description is shortened to at most 4,000 of its ' +
      `${LONG.length.toLocaleString('en-US')} characters. Call cdc_get_dataset_schema with ` +
      'datasetId="ua7e-t2fy" and full_description: true for the whole text.';

    it('caps a long description with the same fields cdc_get_dataset_schema sets', async () => {
      mockGetMetadata.mockResolvedValue({ ...sampleMetadata, description: LONG });
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'ua7e-t2fy' });
      const result = (await datasetDetailResource.handler(params, ctx)) as Record<string, unknown>;

      const description = result.description as string;
      expect(description.length).toBeLessThanOrEqual(4001);
      expect(description.endsWith('…')).toBe(true);
      expect(result.descriptionTruncated).toBe(true);
      expect(result.descriptionLength).toBe(LONG.length);
      expect(result.columns).toEqual(sampleMetadata.columns);
      expect(result.notice).toBe(descriptionNotice);
    });

    it('composes the description notice with the column-window notice into one', async () => {
      mockGetMetadata.mockResolvedValue({
        name: 'Weekly Hospital Respiratory Data',
        description: LONG,
        columns: Array.from({ length: 322 }, (_, i) => ({
          fieldName: `col_${i}`,
          dataType: 'number',
        })),
      });
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'ua7e-t2fy' });
      const result = (await datasetDetailResource.handler(params, ctx)) as Record<string, unknown>;

      expect(result.truncated).toBe(true);
      expect(result.descriptionTruncated).toBe(true);
      expect(result.notice).toBe(
        'Showing the first 100 of 322 columns. Call cdc_get_dataset_schema with datasetId="ua7e-t2fy" and column_offset=100 for the rest; every column is reachable that way. ' +
          descriptionNotice,
      );
    });

    it('names the cap and the tool that returns the whole text in its description', () => {
      expect(datasetDetailResource.description).toContain('4,000');
      expect(datasetDetailResource.description).toContain('full_description: true');
    });
  });

  describe('column window', () => {
    type BoundedDetail = DatasetMetadata & {
      columnCount: number;
      truncated: boolean;
      notice?: string;
    };

    it('returns a narrow schema whole and marks it complete', async () => {
      mockGetMetadata.mockResolvedValue(sampleMetadata);
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'bi63-dtpu' });
      const result = (await datasetDetailResource.handler(params, ctx)) as BoundedDetail;

      expect(result.columns).toHaveLength(2);
      expect(result.columnCount).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.notice).toBeUndefined();
    });

    it('bounds a wide schema and names the tool that reaches the rest', async () => {
      mockGetMetadata.mockResolvedValue({
        name: 'Weekly Hospital Respiratory Data',
        columns: Array.from({ length: 322 }, (_, i) => ({
          fieldName: `col_${i}`,
          dataType: 'number',
          description: `Description of column ${i}`,
        })),
      });
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'ua7e-t2fy' });
      const result = (await datasetDetailResource.handler(params, ctx)) as BoundedDetail;

      expect(result.columns).toHaveLength(100);
      expect(result.columns[0]?.fieldName).toBe('col_0');
      expect(result.columnCount).toBe(322);
      expect(result.truncated).toBe(true);
      expect(result.notice).toContain('cdc_get_dataset_schema');
      expect(result.notice).toContain('column_offset');
    });

    it('keeps the descriptions of the columns it does return', async () => {
      const longDescription = 'D'.repeat(900);
      mockGetMetadata.mockResolvedValue({
        name: 'Verbose',
        columns: [{ fieldName: 'a', dataType: 'text', description: longDescription }],
      });
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'ab12-cd34' });
      const result = (await datasetDetailResource.handler(params, ctx)) as BoundedDetail;

      expect(result.columns[0]?.description).toBe(longDescription);
    });
  });

  it('rejects invalid dataset ID in params schema', () => {
    expect(() => datasetDetailResource.params!.parse({ datasetId: 'bad-id!' })).toThrow();
  });

  it('propagates service errors', async () => {
    mockGetMetadata.mockRejectedValue(new Error('Dataset not found'));
    const ctx = createMockContext({ errors: datasetDetailResource.errors });
    const params = datasetDetailResource.params!.parse({ datasetId: 'bi63-dtpu' });
    await expect(datasetDetailResource.handler(params, ctx)).rejects.toThrow(/not found/);
  });
});
