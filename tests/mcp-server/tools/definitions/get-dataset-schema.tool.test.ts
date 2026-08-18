/**
 * @fileoverview Tests for cdc_get_dataset_schema tool.
 * @module tests/mcp-server/tools/definitions/get-dataset-schema
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
    const ctx = createMockContext({ errors: getDatasetSchema.errors });
    const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
    const result = await getDatasetSchema.handler(input, ctx);

    expect(result.name).toBe('Diabetes Mortality');
    expect(result.rowCount).toBe(50000);
    expect(result.columns).toHaveLength(3);
    // Default domain is threaded as the third argument.
    expect(mockGetMetadata).toHaveBeenCalledWith('bi63-dtpu', ctx.signal, 'data.cdc.gov');
  });

  it('threads an explicit domain through to getMetadata', async () => {
    mockGetMetadata.mockResolvedValue(sampleMetadata);
    const ctx = createMockContext({ errors: getDatasetSchema.errors });
    const input = getDatasetSchema.input.parse({
      datasetId: 'swc5-untb',
      domain: 'chronicdata.cdc.gov',
    });
    await getDatasetSchema.handler(input, ctx);

    expect(mockGetMetadata).toHaveBeenCalledWith('swc5-untb', ctx.signal, 'chronicdata.cdc.gov');
  });

  it('defaults domain to data.cdc.gov', () => {
    expect(getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' }).domain).toBe('data.cdc.gov');
  });

  it('rejects invalid dataset ID format', () => {
    expect(() => getDatasetSchema.input.parse({ datasetId: 'invalid' })).toThrow();
    expect(() => getDatasetSchema.input.parse({ datasetId: 'ABCD-1234' })).toThrow();
    expect(() => getDatasetSchema.input.parse({ datasetId: '' })).toThrow();
  });

  it('propagates service errors', async () => {
    mockGetMetadata.mockRejectedValue(new Error('Dataset not found (404).'));
    const ctx = createMockContext({ errors: getDatasetSchema.errors });
    const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
    await expect(getDatasetSchema.handler(input, ctx)).rejects.toThrow(/not found/);
  });

  describe('column window', () => {
    /** A schema the width of ua7e-t2fy (Weekly Hospital Respiratory Data). */
    const wideMetadata: DatasetMetadata = {
      name: 'Weekly Hospital Respiratory Data',
      columns: Array.from({ length: 322 }, (_, i) => ({
        fieldName: `col_${i}`,
        dataType: 'number',
        description: `Description of column ${i}`,
      })),
    };

    it('returns a narrow schema whole and reports its column total', async () => {
      mockGetMetadata.mockResolvedValue(sampleMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'bi63-dtpu' });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(3);
      expect(enrichment.truncated).toBeUndefined();
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toBeUndefined();
    });

    it('bounds a 322-column schema at the default window and points at the next page', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'ua7e-t2fy' });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(100);
      expect(result.columns[0]?.fieldName).toBe('col_0');
      expect(result.columns[99]?.fieldName).toBe('col_99');

      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(322);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.shown).toBe(100);
      expect(enrichment.cap).toBe(100);
      expect(enrichment.nextOffset).toBe(100);
      expect(enrichment.notice).toContain('column_offset=100');
    });

    it('keeps selected column descriptions whole rather than truncating them', async () => {
      const longDescription = 'D'.repeat(1200);
      mockGetMetadata.mockResolvedValue({
        name: 'Verbose',
        columns: [{ fieldName: 'a', dataType: 'text', description: longDescription }],
      });
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' }),
        ctx,
      );
      expect(result.columns[0]?.description).toBe(longDescription);
    });

    it('continues from an explicit column_offset', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_offset: 100,
      });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns[0]?.fieldName).toBe('col_100');
      expect(result.columns).toHaveLength(100);
      expect(getEnrichment(ctx).nextOffset).toBe(200);
    });

    it('returns the final page without a nextOffset', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_offset: 300,
      });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(22);
      expect(result.columns[21]?.fieldName).toBe('col_321');
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.nextOffset).toBeUndefined();
      expect(enrichment.notice).toContain('322');
    });

    it('reaches every column across a sequence of calls', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const seen: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const ctx = createMockContext({ errors: getDatasetSchema.errors });
        const input = getDatasetSchema.input.parse({
          datasetId: 'ua7e-t2fy',
          column_offset: offset,
        });
        const page = await getDatasetSchema.handler(input, ctx);
        seen.push(...page.columns.map((c) => c.fieldName));
        offset = getEnrichment(ctx).nextOffset as number | undefined;
      }
      expect(seen).toHaveLength(322);
      expect(new Set(seen).size).toBe(322);
    });

    it('returns the whole wide schema when column_limit is raised', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_limit: 500,
      });
      const result = await getDatasetSchema.handler(input, ctx);

      expect(result.columns).toHaveLength(322);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(322);
      expect(enrichment.truncated).toBeUndefined();
    });

    it('renders the windowed columns in content[] as well as structuredContent', async () => {
      mockGetMetadata.mockResolvedValue(wideMetadata);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({
        datasetId: 'ua7e-t2fy',
        column_limit: 5,
        column_offset: 10,
      });
      const result = await getDatasetSchema.handler(input, ctx);
      const text = (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text;

      for (const column of result.columns) expect(text).toContain(`\`${column.fieldName}\``);
      expect(text).toContain('Description of column 14');
      expect(text).not.toContain('`col_15`');
    });
  });

  describe('format', () => {
    it('renders a markdown table of columns', () => {
      const blocks = getDatasetSchema.format!(sampleMetadata);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('text');
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
