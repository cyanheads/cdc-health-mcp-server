/**
 * @fileoverview Edge-case tests for cdc://datasets/{datasetId} resource.
 * @module tests/mcp-server/resources/definitions/dataset-detail-edge
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import type { DatasetMetadata } from '@/services/socrata/types.js';
import { readResourceError } from '../../../helpers/resource-read.js';

const mockGetMetadata = vi.fn<() => Promise<DatasetMetadata>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({ getMetadata: mockGetMetadata }),
}));

/**
 * `list()` receives the SDK's server context, not a handler Context, and this
 * listing ignores it. The stub carries the members the type requires and
 * rejects on every server-to-client call so an accidental use is loud.
 */
type ListExtra = Parameters<NonNullable<typeof datasetDetailResource.list>>[0];

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

describe('cdc://datasets/{datasetId} — edge cases', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('params schema validation', () => {
    it('lowercases an ID with uppercase letters before it reaches Socrata', async () => {
      mockGetMetadata.mockResolvedValue({
        name: 'Cased',
        columns: [{ fieldName: 'id', dataType: 'text' }],
      });
      const params = datasetDetailResource.params!.parse({ datasetId: 'AB12-cd34' });
      expect(params.datasetId).toBe('ab12-cd34');

      await datasetDetailResource.handler(
        params,
        createMockContext({ errors: datasetDetailResource.errors }),
      );
      expect(mockGetMetadata).toHaveBeenCalledWith('ab12-cd34', expect.anything());
    });

    it('rejects an ID no case makes valid with -32007, naming the four-by-four form', async () => {
      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/AB12-cd3');

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.message).toContain('datasetId: Expected a four-by-four ID such as "bi63-dtpu".');
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
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'ab12-cd34' });
      const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

      expect(result.name).toBe('Sparse');
      expect(result.rowCount).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
      expect(result.description).toBeUndefined();
    });

    it('passes dataset ID to service correctly', async () => {
      const meta: DatasetMetadata = {
        name: 'Test',
        columns: [{ fieldName: 'state', dataType: 'text' }],
      };
      mockGetMetadata.mockResolvedValue(meta);
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: 'zz99-ww88' });
      await datasetDetailResource.handler(params, ctx);
      expect(mockGetMetadata).toHaveBeenCalledWith('zz99-ww88', ctx.signal);
    });

    it('fails as not_queryable rather than returning an empty columns array', async () => {
      mockGetMetadata.mockResolvedValue({ name: 'trailheads', columns: [] });

      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/2g2d-yfx9');
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({
        reason: 'not_queryable',
        recovery: { hint: expect.stringContaining('columnCount') },
      });
      expect(err.message).toContain('2g2d-yfx9');
      expect(err.message).not.toContain('view of dataset');
    });

    it('names the dataset a chart is built on in the message and the recovery hint', async () => {
      mockGetMetadata.mockResolvedValue({
        name: 'National Weekly Pfizer Allocations',
        columns: [],
        parentId: 'saz5-9hgg',
      });

      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/sxbq-3sid');
      expect(err.data.reason).toBe('not_queryable');
      expect(err.message).toContain('It is a view of dataset saz5-9hgg');
      expect(err.data.recovery?.hint).toBe(
        'Read cdc://datasets/saz5-9hgg, the dataset this asset is built on, then query that ID with cdc_query_dataset.',
      );
      expect(mockGetMetadata).toHaveBeenCalledTimes(1);
    });

    it('names a file, its size in bytes, and its download URL in the message and the hint', async () => {
      const download = 'https://data.cdc.gov/download/235m-gsry';
      mockGetMetadata.mockResolvedValue({
        name: 'Pulmonary evaluation of 3D printer emissions',
        columns: [],
        file: { downloadUrl: download, name: 'rd-1083-2024-0.zip', sizeBytes: 306191 },
      });

      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/235m-gsry');
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data.reason).toBe('not_queryable');
      expect(err.message).toBe(
        `Dataset 235m-gsry ("Pulmonary evaluation of 3D printer emissions") has no columns. The ID names a non-tabular catalog asset, so there is no schema to return and cdc_query_dataset cannot read it. It is a file, "rd-1083-2024-0.zip" (306,191 bytes), downloadable from ${download}, which redirects to the file.`,
      );
      expect(err.data.recovery?.hint).toBe(
        `Download the file with a GET request to ${download} rather than querying this ID.`,
      );
      // The read names no host, so the service resolves it, and the URL, from CDC_BASE_URL.
      expect(mockGetMetadata).toHaveBeenCalledWith('235m-gsry', expect.anything());
    });

    it('still names the download URL of a file document recording no name or size', async () => {
      const download = 'https://data.cdc.gov/download/235m-gsry';
      mockGetMetadata.mockResolvedValue({
        name: 'Pulmonary evaluation of 3D printer emissions',
        columns: [],
        file: { downloadUrl: download },
      });

      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/235m-gsry');
      expect(err.message).toContain(`It is a file, downloadable from ${download},`);
      expect(err.message).not.toContain('bytes');
      expect(err.data.recovery?.hint).toContain(download);
    });

    it('carries parentId on a filter it reads', async () => {
      mockGetMetadata.mockResolvedValue({
        name: 'Smokefree Indoor Air table',
        columns: [{ fieldName: 'state', dataType: 'text' }],
        parentId: '32fd-hyzc',
      });
      const ctx = createMockContext({ errors: datasetDetailResource.errors });
      const params = datasetDetailResource.params!.parse({ datasetId: '2389-pvg9' });
      const result = (await datasetDetailResource.handler(params, ctx)) as DatasetMetadata;

      expect(result.parentId).toBe('32fd-hyzc');
    });
  });

  describe('list()', () => {
    it('returns example dataset URIs', async () => {
      const listing = await datasetDetailResource.list!(makeListExtra());
      expect(listing.resources.length).toBeGreaterThan(0);
      for (const r of listing.resources) {
        expect(r.uri).toMatch(/^cdc:\/\/datasets\/[a-z0-9]{4}-[a-z0-9]{4}$/);
      }
    });
  });

  describe('handler — service error re-throw with recovery', () => {
    it('surfaces recovery.hint when the service throws a reason-tagged McpError', async () => {
      const serviceErr = new McpError(JsonRpcErrorCode.NotFound, 'Dataset not found (404).', {
        reason: 'dataset_not_found',
      });
      mockGetMetadata.mockRejectedValue(serviceErr);

      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/ab12-cd34');
      expect(err.data).toMatchObject({
        reason: 'dataset_not_found',
        recovery: { hint: expect.stringContaining('cdc_discover_datasets') },
      });
    });
  });
});
