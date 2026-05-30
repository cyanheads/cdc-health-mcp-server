/**
 * @fileoverview Edge-case tests for cdc_get_dataset_schema: sparse metadata, format variants.
 * @module tests/mcp-server/tools/definitions/get-dataset-schema-edge
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';

const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ getMetadata: mockGetMetadata }),
}));

describe('cdc_get_dataset_schema — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('sparse metadata', () => {
    it('handles metadata with no rowCount, no updatedAt, no description', async () => {
      const sparseMetadata: DatasetMetadata = {
        name: 'Minimal Dataset',
        columns: [{ fieldName: 'id', dataType: 'number' }],
        // rowCount, updatedAt, description omitted
      };
      mockGetMetadata.mockResolvedValue(sparseMetadata);
      const ctx = createMockContext();
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.name).toBe('Minimal Dataset');
      expect(result.rowCount).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
      expect(result.description).toBeUndefined();
      expect(result.columns).toHaveLength(1);
    });

    it('handles empty columns array', async () => {
      const meta: DatasetMetadata = { name: 'No Columns', columns: [] };
      mockGetMetadata.mockResolvedValue(meta);
      const ctx = createMockContext();
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });
      const result = await getDatasetSchema.handler(input, ctx);
      expect(result.columns).toHaveLength(0);
    });

    it('handles column with no description', async () => {
      const meta: DatasetMetadata = {
        name: 'Dataset',
        columns: [{ fieldName: 'mystery', dataType: 'text' /* no description */ }],
      };
      mockGetMetadata.mockResolvedValue(meta);
      const ctx = createMockContext();
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });
      const result = await getDatasetSchema.handler(input, ctx);
      expect(result.columns[0].description).toBeUndefined();
    });
  });

  describe('input validation — boundary IDs', () => {
    it('accepts all-digit four-by-four ID', () => {
      const input = getDatasetSchema.input.parse({ datasetId: '1234-5678' });
      expect(input.datasetId).toBe('1234-5678');
    });

    it('accepts all-alpha (lowercase) four-by-four ID', () => {
      const input = getDatasetSchema.input.parse({ datasetId: 'abcd-efgh' });
      expect(input.datasetId).toBe('abcd-efgh');
    });

    it('rejects ID with uppercase letters', () => {
      expect(() => getDatasetSchema.input.parse({ datasetId: 'AB12-cd34' })).toThrow();
    });

    it('rejects ID that is only 7 chars (too short)', () => {
      expect(() => getDatasetSchema.input.parse({ datasetId: 'ab12-cd3' })).toThrow();
    });

    it('rejects ID that is 10 chars (too long)', () => {
      expect(() => getDatasetSchema.input.parse({ datasetId: 'ab12-cd345' })).toThrow();
    });
  });

  describe('format — edge cases', () => {
    it('renders dash when rowCount is omitted', () => {
      const meta: DatasetMetadata = { name: 'No Count', columns: [] };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Rows:** —');
    });

    it('renders dash when updatedAt is omitted', () => {
      const meta: DatasetMetadata = { name: 'No Date', columns: [] };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Updated:** —');
    });

    it('renders description when present', () => {
      const meta: DatasetMetadata = {
        name: 'Described',
        description: 'This is a detailed description.',
        columns: [],
      };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('This is a detailed description.');
    });

    it('renders large row count with locale formatting', () => {
      const meta: DatasetMetadata = {
        name: 'Big Dataset',
        rowCount: 1234567,
        columns: [],
      };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('1,234,567');
    });

    it('renders many columns correctly', () => {
      const columns = Array.from({ length: 20 }, (_, i) => ({
        fieldName: `col_${i}`,
        dataType: 'text',
        description: `Column ${i}`,
      }));
      const meta: DatasetMetadata = { name: 'Wide Dataset', columns };
      const blocks = getDatasetSchema.format!(meta);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('`col_0`');
      expect(text).toContain('`col_19`');
    });
  });
});
