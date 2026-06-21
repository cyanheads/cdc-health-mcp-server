/**
 * @fileoverview Security tests for CDC tool inputs: injection attempts, oversized inputs,
 * and assertions that secrets/env values never appear in tool output or error messages.
 * @module tests/security/tools-security
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import type { DatasetMetadata, DiscoverResult, QueryResult } from '@/services/socrata/types.js';

const mockDiscover = vi.fn<() => Promise<DiscoverResult>>();
const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();
const mockQuery = vi.fn<() => Promise<QueryResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({
    discover: mockDiscover,
    getMetadata: mockGetMetadata,
    query: mockQuery,
  }),
}));

const emptyDiscover: DiscoverResult = { datasets: [], totalCount: 0 };
const emptyQuery: QueryResult = { rows: [], rowCount: 0, query: '' };
const basicMetadata: DatasetMetadata = { name: 'Test', columns: [] };

describe('Security — input validation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('dataset ID format enforcement', () => {
    const invalidIds = [
      'ABCD-1234', // uppercase
      'ab12-cd3', // too short
      'ab12-cd345', // too long
      'ab12cd34', // no hyphen
      'ab12-cd3!', // special char
      '../etc/passwd', // path traversal
      'ab12-cd34; DROP TABLE datasets;', // SQL-style injection
      '../../../../etc/shadow', // deep path traversal
      '',
    ];

    it.each(invalidIds)('rejects datasetId %j in getDatasetSchema', (id) => {
      expect(() => getDatasetSchema.input.parse({ datasetId: id })).toThrow();
    });

    it.each(invalidIds)('rejects datasetId %j in queryDataset', (id) => {
      expect(() => queryDataset.input.parse({ datasetId: id })).toThrow();
    });
  });

  describe('domain allowlist enforcement (SSRF guard)', () => {
    const disallowedDomains = [
      'evil.com',
      'data.cdc.gov.evil.com',
      'http://data.cdc.gov',
      'localhost',
      '169.254.169.254',
      'DATA.CDC.GOV', // case-sensitive enum
      '',
    ];

    it.each(disallowedDomains)('rejects domain %j in discoverDatasets', (domain) => {
      expect(() => discoverDatasets.input.parse({ domain })).toThrow();
    });

    it.each(disallowedDomains)('rejects domain %j in getDatasetSchema', (domain) => {
      expect(() => getDatasetSchema.input.parse({ datasetId: 'ab12-cd34', domain })).toThrow();
    });

    it.each(disallowedDomains)('rejects domain %j in queryDataset', (domain) => {
      expect(() => queryDataset.input.parse({ datasetId: 'ab12-cd34', domain })).toThrow();
    });

    it('accepts the two allowlisted CDC Socrata hosts', () => {
      for (const domain of ['data.cdc.gov', 'chronicdata.cdc.gov'] as const) {
        expect(discoverDatasets.input.parse({ domain }).domain).toBe(domain);
        expect(getDatasetSchema.input.parse({ datasetId: 'ab12-cd34', domain }).domain).toBe(
          domain,
        );
        expect(queryDataset.input.parse({ datasetId: 'ab12-cd34', domain }).domain).toBe(domain);
      }
    });

    it('defaults domain to data.cdc.gov when omitted', () => {
      expect(discoverDatasets.input.parse({}).domain).toBe('data.cdc.gov');
      expect(getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' }).domain).toBe('data.cdc.gov');
      expect(queryDataset.input.parse({ datasetId: 'ab12-cd34' }).domain).toBe('data.cdc.gov');
    });
  });

  describe('discoverDatasets — input bounds', () => {
    it('rejects limit of 0', () => {
      expect(() => discoverDatasets.input.parse({ limit: 0 })).toThrow();
    });

    it('rejects limit above 100', () => {
      expect(() => discoverDatasets.input.parse({ limit: 101 })).toThrow();
    });

    it('rejects negative offset', () => {
      expect(() => discoverDatasets.input.parse({ offset: -1 })).toThrow();
    });

    it('rejects offset above 9999', () => {
      expect(() => discoverDatasets.input.parse({ offset: 10000 })).toThrow();
    });

    it('accepts oversized query string without throwing at schema level (passed to service)', async () => {
      // The tool schema does not restrict query length — oversized queries are passed to
      // the service which handles them. This test confirms the tool does not crash on long input.
      mockDiscover.mockResolvedValue(emptyDiscover);
      const longQuery = 'x'.repeat(2000);
      const ctx = createMockContext();
      const input = discoverDatasets.input.parse({ query: longQuery });
      await discoverDatasets.handler(input, ctx);
      expect(mockDiscover).toHaveBeenCalledWith(
        expect.objectContaining({ query: longQuery }),
        ctx.signal,
      );
    });
  });

  describe('queryDataset — input bounds', () => {
    it('rejects limit of 0', () => {
      expect(() => queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 0 })).toThrow();
    });

    it('rejects limit above 5000', () => {
      expect(() => queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 5001 })).toThrow();
    });

    it('accepts limit of 1 (minimum boundary)', () => {
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 1 });
      expect(input.limit).toBe(1);
    });

    it('accepts limit of 5000 (maximum boundary)', () => {
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 5000 });
      expect(input.limit).toBe(5000);
    });

    it('rejects negative offset', () => {
      expect(() => queryDataset.input.parse({ datasetId: 'ab12-cd34', offset: -1 })).toThrow();
    });
  });

  describe('SoQL injection — query clauses are passed to service (no server-side sanitization)', () => {
    // These tests document expected behavior: the server forwards SoQL clauses as-is to
    // the Socrata API. Socrata itself is responsible for parsing and rejecting malformed queries.
    // The server's security boundary is dataset ID format and numeric range constraints.

    it('forwards WHERE clause with SQL-style injection attempt to service', async () => {
      mockQuery.mockResolvedValue(emptyQuery);
      const ctx = createMockContext();
      const injectionWhere = "year=2020 OR '1'='1'";
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: injectionWhere });
      await queryDataset.handler(input, ctx);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({ where: injectionWhere }),
        ctx.signal,
      );
    });
  });

  describe('no secrets in tool output', () => {
    it('discover result does not include env var names or values', async () => {
      mockDiscover.mockResolvedValue({
        datasets: [
          {
            id: 'ab12-cd34',
            name: 'Test Dataset',
            description: 'A dataset',
          },
        ],
        totalCount: 1,
      });
      const ctx = createMockContext();
      const input = discoverDatasets.input.parse({ query: 'test' });
      const result = await discoverDatasets.handler(input, ctx);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('CDC_APP_TOKEN');
      expect(serialized).not.toContain('CDC_BASE_URL');
      expect(serialized).not.toContain('CDC_CATALOG_URL');
    });

    it('schema result does not include env var names', async () => {
      mockGetMetadata.mockResolvedValue(basicMetadata);
      const ctx = createMockContext();
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });
      const result = await getDatasetSchema.handler(input, ctx);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('CDC_APP_TOKEN');
      expect(serialized).not.toContain('process.env');
    });

    it('query result does not include env var names', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ state: 'Texas', deaths: '100' }],
        rowCount: 1,
        query: '$where=year=2020',
      });
      const ctx = createMockContext();
      const input = queryDataset.input.parse({ datasetId: 'ab12-cd34', where: 'year=2020' });
      const result = await queryDataset.handler(input, ctx);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('CDC_APP_TOKEN');
      expect(serialized).not.toContain('process.env');
    });
  });

  describe('format — output encoding', () => {
    it('queryDataset format collapses newlines in cell values to spaces', () => {
      const blocks = queryDataset.format!({
        rows: [{ note: 'line1\nline2' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // Cell value with embedded newline is rendered as a single-line 'line1 line2'
      expect(text).toContain('line1 line2');
      // The cell itself should not contain a raw newline (it was collapsed)
      const tableRows = text.split('\n').filter((l) => l.startsWith('|'));
      const dataRow = tableRows.find((l) => l.includes('line1'));
      expect(dataRow).toBeDefined();
      expect(dataRow).not.toContain('\n');
    });

    it('discoverDatasets format handles unicode characters in dataset names', () => {
      const blocks = discoverDatasets.format!({
        datasets: [
          {
            id: 'ab12-cd34',
            name: 'Données épidémiologiques — données COVID‑19',
            description: '日本語テスト',
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Données épidémiologiques');
      expect(text).toContain('COVID‑19');
      expect(text).toContain('日本語テスト');
    });

    it('queryDataset format handles non-string cell values (e.g., GeoJSON)', () => {
      const geoValue = { type: 'Point', coordinates: [-73.93, 40.73] };
      const blocks = queryDataset.format!({
        rows: [{ location: geoValue, name: 'NYC' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Point');
      expect(text).toContain('NYC');
    });

    it('queryDataset format handles null/undefined cell values', () => {
      const blocks = queryDataset.format!({
        rows: [{ state: null, year: undefined, deaths: '100' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // null and undefined render as empty strings — no crash
      expect(text).toContain('100');
      expect(text).toContain('deaths');
    });
  });
});
