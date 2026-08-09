/**
 * @fileoverview Edge-case tests for cdc_get_dataset_schema: sparse metadata, format variants.
 * @module tests/mcp-server/tools/definitions/get-dataset-schema-edge
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

    it('fails as not_queryable rather than returning an empty columns array', async () => {
      /**
       * A `file`, `href`, `chart`, `map`, or `story` catalog asset answers the metadata
       * endpoint with a 200 and zero columns. Returning that bare is a failed lookup
       * dressed as a result — the caller learns nothing and spends another call finding out.
       */
      const meta: DatasetMetadata = {
        name: 'Pulmonary evaluation of 3D printer emissions',
        columns: [],
      };
      mockGetMetadata.mockResolvedValue(meta);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: '235m-gsry' });

      const err = (await getDatasetSchema.handler(input, ctx).catch((e) => e)) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({
        reason: 'not_queryable',
        recovery: { hint: expect.stringContaining('columnCount') },
      });
      expect(err.message).toContain('235m-gsry');
      expect(err.message).toContain('has no columns');
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

  describe('handler — service error re-throw with recovery', () => {
    it('re-throws McpError with ctx.fail and recoveryFor when reason is declared', async () => {
      const serviceErr = new McpError(JsonRpcErrorCode.NotFound, 'Dataset not found (404).', {
        reason: 'dataset_not_found',
      });
      mockGetMetadata.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });

      await expect(getDatasetSchema.handler(input, ctx)).rejects.toMatchObject({
        data: expect.objectContaining({
          reason: 'dataset_not_found',
          recovery: { hint: expect.stringContaining('cdc_discover_datasets') },
        }),
      });
    });

    it('re-throws non-McpError errors unchanged', async () => {
      mockGetMetadata.mockRejectedValue(new Error('network failure'));
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });

      await expect(getDatasetSchema.handler(input, ctx)).rejects.toThrow('network failure');
    });

    it.each([JsonRpcErrorCode.InternalError, JsonRpcErrorCode.Timeout])(
      'reports every 5xx as the contract ServiceUnavailable, whatever code the status carried (%i)',
      async (serviceCode) => {
        /**
         * The framework splits 5xx across InternalError (500/501), ServiceUnavailable
         * (502/503) and Timeout (504). The handler rebuilds from the contract entry, so
         * `upstream_error` is what makes the band land on one retryable code — a caller
         * seeing a bare InternalError for a 500 would have no recovery to act on.
         */
        mockGetMetadata.mockRejectedValue(
          new McpError(serviceCode, 'Socrata returned a server error.', {
            reason: 'upstream_error',
          }),
        );
        const ctx = createMockContext({ errors: getDatasetSchema.errors });
        const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });

        const err = (await getDatasetSchema.handler(input, ctx).catch((e) => e)) as McpError;
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
      },
    );

    it('rethrows an unreasoned service error without leaking the declared-reason list', async () => {
      /**
       * This is the failure the reason ladder is arranged to avoid. A status the service
       * leaves unreasoned must miss the `err.data.reason` dispatch entirely: routing it
       * through `ctx.fail` with a reason no contract declares does not fall back to the
       * thrown code — it returns an InternalError whose data carries every declared reason
       * of this tool straight to the caller.
       */
      const serviceErr = new McpError(JsonRpcErrorCode.Unauthorized, 'Socrata returned 401.', {
        url: 'https://data.cdc.gov/api/views/ab12-cd34.json',
      });
      mockGetMetadata.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' });

      const err = (await getDatasetSchema.handler(input, ctx).catch((e) => e)) as McpError;
      expect(err).toBe(serviceErr);
      expect(err.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect(err.code).not.toBe(JsonRpcErrorCode.InternalError);
      expect(err.data).not.toHaveProperty('declaredReasons');
      expect(JSON.stringify(err.data)).not.toContain('not_queryable');
    });

    it('surfaces a service 403 as Forbidden with a recovery that does not promise a retry', async () => {
      /**
       * The catch block dispatches on the reason string alone, so a 403 tagged
       * upstream_error arrived as a retryable ServiceUnavailable telling the caller the
       * portal might be down. A distinct reason keeps the code and the advice honest.
       */
      const serviceErr = new McpError(
        JsonRpcErrorCode.Forbidden,
        'Socrata denied access to this resource (403).',
        { reason: 'access_denied' },
      );
      mockGetMetadata.mockRejectedValue(serviceErr);
      const ctx = createMockContext({ errors: getDatasetSchema.errors });
      const input = getDatasetSchema.input.parse({ datasetId: '235m-gsry' });

      const err = (await getDatasetSchema.handler(input, ctx).catch((e) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
      const data = err.data as { reason: string; retryable?: boolean; recovery: { hint: string } };
      expect(data.reason).toBe('access_denied');
      expect(data.retryable).toBeUndefined();
      expect(data.recovery.hint).toContain('cdc_discover_datasets');
      expect(data.recovery.hint).not.toMatch(/temporarily unavailable|retry after/i);
    });
  });

  describe('format — untrusted column metadata', () => {
    it('keeps one table row per column when a description carries newlines and pipes', () => {
      /**
       * Socrata column descriptions are free text: hn4x-zwk7 ships two whose descriptions
       * end in a literal newline, which terminates the row and drops every column after it
       * into loose prose for content[]-only clients.
       */
      const meta: DatasetMetadata = {
        name: 'Escaping',
        columns: [
          {
            fieldName: 'data_value_type',
            dataType: 'text',
            description: 'Description of type of data e.g. Value, Percentage, Number\n',
          },
          {
            fieldName: 'total',
            dataType: 'text',
            description: 'Total/Overall breakout category\n',
          },
          {
            fieldName: 'range',
            dataType: 'text',
            description: 'Low | High bounds\nsecond line',
          },
          { fieldName: 'data_value', dataType: 'number', description: 'Data value' },
        ],
      };
      const text = (getDatasetSchema.format!(meta)[0] as { type: 'text'; text: string }).text.split(
        '\n',
      );
      const rows = text.filter((l) => l.startsWith('| `'));

      expect(rows).toEqual([
        '| `data_value_type` | text | Description of type of data e.g. Value, Percentage, Number |',
        '| `total` | text | Total/Overall breakout category |',
        '| `range` | text | Low \\| High bounds second line |',
        '| `data_value` | number | Data value |',
      ]);
      // Every rendered row has exactly the three cells the header declares.
      for (const row of rows) {
        expect(row.replaceAll('\\|', '').split('|').filter(Boolean)).toHaveLength(3);
      }
    });

    it('escapes fieldName and dataType, which come from the same upstream payload', () => {
      const meta: DatasetMetadata = {
        name: 'Hostile',
        columns: [{ fieldName: 'a|b', dataType: 'text\nnumber' }],
      };
      const text = (getDatasetSchema.format!(meta)[0] as { type: 'text'; text: string }).text;
      const row = text.split('\n').find((l) => l.startsWith('| `'));
      expect(row).toBe('| `a\\|b` | text number | — |');
    });
  });
});
