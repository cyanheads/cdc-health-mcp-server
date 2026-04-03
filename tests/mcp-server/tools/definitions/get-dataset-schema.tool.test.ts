/**
 * @fileoverview Tests for cdc_get_dataset_schema tool.
 * @module tests/mcp-server/tools/definitions/get-dataset-schema
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
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
    { fieldName: 'deaths', dataType: 'number', description: 'Number of deaths' },
  ],
};

describe('cdc_get_dataset_schema', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns metadata for a valid dataset ID', async () => {
    mockGetMetadata.mockResolvedValue(sampleMetadata);
    const ctx = createMockContext();
    const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
    const result = await getDatasetSchema.handler(input, ctx);

    expect(result.name).toBe('Diabetes Mortality');
    expect(result.rowCount).toBe(50000);
    expect(result.columns).toHaveLength(3);
    expect(mockGetMetadata).toHaveBeenCalledWith('bi63-dtpu', ctx.signal);
  });

  it('rejects invalid dataset ID format', () => {
    expect(() => getDatasetSchema.input.parse({ datasetId: 'invalid' })).toThrow();
    expect(() => getDatasetSchema.input.parse({ datasetId: 'ABCD-1234' })).toThrow();
    expect(() => getDatasetSchema.input.parse({ datasetId: '' })).toThrow();
  });

  it('propagates service errors', async () => {
    mockGetMetadata.mockRejectedValue(new Error('Dataset not found (404).'));
    const ctx = createMockContext();
    const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
    await expect(getDatasetSchema.handler(input, ctx)).rejects.toThrow(/not found/);
  });

  describe('format', () => {
    it('renders a markdown table of columns', () => {
      const blocks = getDatasetSchema.format!(sampleMetadata);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Diabetes Mortality');
      expect(text).toContain('50,000');
      expect(text).toContain('| `state` | text | US state name |');
      expect(text).toContain('| `year` | number | Data year |');
      expect(text).toContain('| `deaths` | number | Number of deaths |');
    });

    it('renders dash for missing column description', () => {
      const meta = {
        ...sampleMetadata,
        columns: [{ fieldName: 'mystery', dataType: 'text', description: '' }],
      };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('| `mystery` | text | — |');
    });
  });
});
