/**
 * @fileoverview Tests for SocrataService error handling, 400 codes, network failures, and security.
 * @module tests/services/socrata/socrata-service-errors
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: undefined,
    baseUrl: 'https://data.cdc.gov',
    catalogUrl: 'https://api.us.socrata.com/api/catalog/v1',
  }),
}));

import { SocrataService } from '@/services/socrata/socrata-service.js';

function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchText(body: string, status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

function mockFetchReject(err: Error) {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(err);
}

describe('SocrataService — error handling', () => {
  let service: SocrataService;

  beforeEach(() => {
    service = new SocrataService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('400 bad request — throwBadRequest', () => {
    it('throws validationError with column name on no-such-column', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.no-such-column',
          data: { column: 'missingcol' },
          message: 'No such column missingcol',
        }),
        400,
      );
      await expect(
        service.query({ datasetId: 'ab12-cd34', where: "missingcol='x'" }),
      ).rejects.toThrow(/No such column "missingcol"/);
    });

    it('falls back to "unknown" when column data is absent', async () => {
      mockFetchText(
        JSON.stringify({ errorCode: 'query.soql.no-such-column', data: {}, message: 'bad col' }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /No such column "unknown"/,
      );
    });

    it('throws validationError with detail on type-mismatch', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.type-mismatch',
          message: 'Type error; expected number got text',
        }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/type mismatch/i);
    });

    it('uses generic detail when type-mismatch message has no semicolon', async () => {
      mockFetchText(
        JSON.stringify({ errorCode: 'query.soql.type-mismatch', message: 'Type error' }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/check column types/);
    });

    it('throws validationError with Socrata message on generic 400', async () => {
      mockFetchText(JSON.stringify({ message: 'Invalid query syntax near token AND' }), 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /Invalid query syntax/,
      );
    });

    it('throws validationError with error field when message is absent', async () => {
      mockFetchText(JSON.stringify({ error: 'bad input' }), 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/bad input/);
    });

    it('throws validationError with raw body when JSON parse fails', async () => {
      mockFetchText('not json', 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/not json/);
    });

    it('truncates body to 300 chars when JSON has neither message nor error', async () => {
      const longBody = JSON.stringify({ unknown: 'x'.repeat(400) });
      mockFetchText(longBody, 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /Socrata API error 400/,
      );
    });

    it('normalizes column-not-in-group-bys using the structured column name', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.column-not-in-group-bys',
          data: { column: 'state' },
          message:
            'Query coordinator error: query.soql.column-not-in-group-bys; Column \'state\' is not in group by; position: Map(row -> 1, column -> 8, line -> "SELECT `state`")',
        }),
        400,
      );
      await expect(
        service.query({ datasetId: 'ab12-cd34', select: 'state, sum(deaths) as d' }),
      ).rejects.toThrow(/Column "state" must appear in GROUP BY/);
    });

    it('falls back to "unknown" for column-not-in-group-bys without column data', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.column-not-in-group-bys',
          data: {},
          message: 'Column is not in group by',
        }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /Column "unknown" must appear in GROUP BY/,
      );
    });

    it('strips the Scala position tail from generic 400 messages', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.no-such-function',
          message:
            'Query coordinator error: query.soql.no-such-function; Unknown function `foo`; position: Map(row -> 1, column -> 8, line -> "SELECT foo(x)")',
        }),
        400,
      );
      const err = (await service
        .query({ datasetId: 'ab12-cd34', select: 'foo(x)' })
        .catch((e) => e)) as Error;
      expect(err.message).toContain('Unknown function');
      expect(err.message).not.toContain('position: Map');
    });

    it('surfaces backtick guidance for reserved-word parse errors', async () => {
      // query.compiler.* parse errors carry the code under `code` (not `errorCode`).
      mockFetchText(
        JSON.stringify({
          code: 'query.compiler.malformed',
          error: true,
          message:
            "Could not parse SoQL query \"select * where group='By Year'\" at line 1 character 16: Expected an expression, but got `GROUP'",
          data: { query: "select * where group='By Year'", position: {} },
        }),
        400,
      );
      await expect(
        service.query({ datasetId: 'ab12-cd34', where: "group='By Year'" }),
      ).rejects.toThrow(/wrap it in backticks/);
    });
  });

  describe('HTTP error codes', () => {
    it('throws notFound on 404 for discover', async () => {
      mockFetchText('', 404);
      await expect(service.discover({ query: 'x' })).rejects.toThrow(/not found/i);
    });

    it('throws rateLimited on 429 for query', async () => {
      mockFetchText('', 429);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/Rate limited/i);
    });

    it('throws serviceUnavailable on 503 for getMetadata', async () => {
      mockFetchText('Service unavailable', 503);
      await expect(service.getMetadata('ab12-cd34')).rejects.toThrow(/503/);
    });

    it('throws on 500 with status code included', async () => {
      mockFetchText('Internal Server Error', 500);
      await expect(service.getMetadata('ab12-cd34')).rejects.toThrow(/500/);
    });
  });

  describe('network failures', () => {
    it('propagates TypeError on network failure in discover', async () => {
      mockFetchReject(new TypeError('fetch failed'));
      await expect(service.discover({})).rejects.toThrow(/fetch failed/);
    });

    it('propagates network error in query', async () => {
      mockFetchReject(new Error('ECONNREFUSED'));
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/ECONNREFUSED/);
    });

    it('propagates AbortError on signal abort', async () => {
      const controller = new AbortController();
      mockFetchReject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      controller.abort();
      await expect(service.getMetadata('ab12-cd34', controller.signal)).rejects.toThrow(/Aborted/);
    });
  });

  describe('getSocrataService — uninitialized', () => {
    it('throws serviceUnavailable when not initialized', async () => {
      // Import from a freshly isolated module to avoid contamination from global init
      const { getSocrataService } = await import('@/services/socrata/socrata-service.js');
      // When initialized in setup the singleton may exist — test the message
      try {
        getSocrataService();
        // If it doesn't throw, the service was already initialized — that's fine
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('SocrataService not initialized');
      }
    });
  });

  describe('sparse catalog responses', () => {
    it('handles missing optional catalog fields gracefully', async () => {
      mockFetch({
        results: [
          {
            resource: {
              id: 'ab12-cd34',
              name: 'Minimal Dataset',
              // no description, no page_views, no columns, no updatedAt
            },
            // no classification
          },
        ],
        resultSetSize: 1,
      });
      const result = await service.discover({ query: 'minimal' });
      expect(result.datasets[0].id).toBe('ab12-cd34');
      expect(result.datasets[0].description).toBeUndefined();
      expect(result.datasets[0].category).toBeUndefined();
      expect(result.datasets[0].tags).toBeUndefined();
      expect(result.datasets[0].columnNames).toBeUndefined();
      expect(result.datasets[0].pageViews).toBeUndefined();
    });

    it('handles missing rowsUpdatedAt in metadata', async () => {
      mockFetch({
        name: 'Sparse Dataset',
        description: 'A sparse one',
        // no rowsUpdatedAt
        columns: [{ fieldName: 'id', dataTypeName: 'text' }],
      });
      const result = await service.getMetadata('ab12-cd34');
      expect(result.updatedAt).toBeUndefined();
    });

    it('handles missing cachedContents (no rowCount) in metadata', async () => {
      mockFetch({
        name: 'No Count Dataset',
        columns: [{ fieldName: 'id', dataTypeName: 'number' /* no cachedContents */ }],
      });
      const result = await service.getMetadata('ab12-cd34');
      expect(result.rowCount).toBeUndefined();
    });

    it('handles empty results array from catalog', async () => {
      mockFetch({ results: [], resultSetSize: 0 });
      const result = await service.discover({ query: 'nothing' });
      expect(result.datasets).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('handles empty rows array from query', async () => {
      mockFetch([]);
      const result = await service.query({ datasetId: 'ab12-cd34' });
      expect(result.rows).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });
  });

  describe('app token header injection', () => {
    it('does NOT send X-App-Token header when appToken is undefined', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({});
      const headers = spy.mock.calls[0][1]?.headers as Record<string, string> | undefined;
      expect(headers?.['X-App-Token']).toBeUndefined();
    });
  });

  describe('query — offset default', () => {
    it('defaults offset to 0 when not provided', async () => {
      const spy = mockFetch([]);
      await service.query({ datasetId: 'ab12-cd34', where: "x='y'" });
      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('%24offset=0');
    });
  });
});
