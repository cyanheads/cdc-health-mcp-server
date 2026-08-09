/**
 * @fileoverview Security tests for CDC tool inputs: injection attempts, oversized inputs,
 * and assertions that secrets/env values never appear in tool output or error messages.
 * @module tests/security/tools-security
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import type { DiscoverOptions, QueryOptions } from '@/services/socrata/socrata-service.js';
import type {
  DatasetMetadata,
  DiscoverResult,
  QueryResult,
  SocrataDomain,
} from '@/services/socrata/types.js';

/**
 * A token shaped like a real Socrata credential. Every "no secrets" assertion below is
 * only meaningful if this value is actually in play on the code path under test, so the
 * config mock hands it to the real service rather than leaving `appToken` undefined.
 */
const { APP_TOKEN } = vi.hoisted(() => ({ APP_TOKEN: 'cdc-app-tok-S3NT1NEL-never-ship' }));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: APP_TOKEN,
    baseUrl: 'https://data.cdc.gov',
    catalogUrl: 'https://api.us.socrata.com/api/catalog/v1',
  }),
}));

const mockDiscover =
  vi.fn<(options: DiscoverOptions, signal?: AbortSignal) => Promise<DiscoverResult>>();
const mockGetMetadata =
  vi.fn<
    (datasetId: string, signal?: AbortSignal, domain?: SocrataDomain) => Promise<DatasetMetadata>
  >();
const mockQuery = vi.fn<(options: QueryOptions, signal?: AbortSignal) => Promise<QueryResult>>();

vi.mock('@/services/socrata/socrata-service.js', () => ({
  getSocrataService: () => ({
    discover: mockDiscover,
    getMetadata: mockGetMetadata,
    query: mockQuery,
  }),
}));

const emptyDiscover: DiscoverResult = { datasets: [], totalCount: 0 };
const emptyQuery: QueryResult = { rows: [], rowCount: 0, query: '' };

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
    /**
     * Asserting a token is absent proves nothing unless the token is on the code path and
     * could plausibly reach the caller. These tests therefore run the REAL SocrataService
     * under the sentinel `appToken` above and hand its output to the tools, so the whole
     * chain from credential to client payload is exercised. The token enters in exactly
     * one place — the `X-App-Token` request header — and Socrata also accepts it as a
     * `$$app_token` query parameter, which is the mistake these tests exist to catch: that
     * form reaches the caller through `effectiveQuery` and through the `url` on every
     * error the service throws.
     */
    async function withRealService(response: Response) {
      const actual = await vi.importActual<typeof import('@/services/socrata/socrata-service.js')>(
        '@/services/socrata/socrata-service.js',
      );
      const real = new actual.SocrataService();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      mockDiscover.mockImplementation((options, signal) => real.discover(options, signal));
      mockGetMetadata.mockImplementation((id, signal, domain) =>
        real.getMetadata(id, signal, domain),
      );
      mockQuery.mockImplementation((options, signal) => real.query(options, signal));
      return fetchSpy;
    }

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('carries the app token in the request header and nowhere in the request URL', async () => {
      const fetchSpy = await withRealService(json([{ state: 'Texas', deaths: '100' }]));
      const ctx = createMockContext();
      await queryDataset.handler(
        queryDataset.input.parse({ datasetId: 'ab12-cd34', where: 'year=2020' }),
        ctx,
      );

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-App-Token']).toBe(APP_TOKEN);
      expect(url).not.toContain(APP_TOKEN);
      expect(url).not.toContain('app_token');
    });

    it('keeps the app token out of every payload cdc_query_dataset returns', async () => {
      await withRealService(json([{ state: 'Texas', deaths: '100' }]));
      const ctx = createMockContext();
      const result = await queryDataset.handler(
        queryDataset.input.parse({ datasetId: 'ab12-cd34', where: 'year=2020' }),
        ctx,
      );

      const enrichment = getEnrichment(ctx);
      // effectiveQuery echoes the assembled clauses verbatim — a token added as a SoQL
      // parameter would ride straight out with them.
      expect(enrichment.effectiveQuery).toBeDefined();
      const surfaces = [
        JSON.stringify(result),
        JSON.stringify(enrichment),
        (queryDataset.format!(result)[0] as { type: 'text'; text: string }).text,
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(APP_TOKEN);
        expect(surface).not.toContain('CDC_APP_TOKEN');
      }
    });

    it('keeps the app token out of the payloads cdc_discover_datasets returns', async () => {
      await withRealService(
        json({
          results: [{ resource: { id: 'ab12-cd34', name: 'Test', type: 'dataset' } }],
          resultSetSize: 1,
        }),
      );
      const ctx = createMockContext();
      const result = await discoverDatasets.handler(
        discoverDatasets.input.parse({ query: 'test' }),
        ctx,
      );

      for (const surface of [JSON.stringify(result), JSON.stringify(getEnrichment(ctx))]) {
        expect(surface).not.toContain(APP_TOKEN);
        expect(surface).not.toContain('CDC_APP_TOKEN');
      }
    });

    it('keeps the app token out of the payloads cdc_get_dataset_schema returns', async () => {
      await withRealService(
        json({
          name: 'Test',
          columns: [{ fieldName: 'state', dataTypeName: 'text' }],
        }),
      );
      const ctx = createMockContext();
      const result = await getDatasetSchema.handler(
        getDatasetSchema.input.parse({ datasetId: 'ab12-cd34' }),
        ctx,
      );

      const surfaces = [
        JSON.stringify(result),
        (getDatasetSchema.format!(result)[0] as { type: 'text'; text: string }).text,
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(APP_TOKEN);
        expect(surface).not.toContain('CDC_APP_TOKEN');
      }
    });

    it('keeps the app token out of a reasoned failure, which reaches the caller as a message', async () => {
      /**
       * A reasoned failure is rebuilt by the handler from the contract, so only
       * `err.message` — Socrata's own text plus whatever the service interpolates —
       * crosses to the client.
       */
      await withRealService(
        json({ error: true, message: 'no row or column access to non-tabular tables' }, 403),
      );
      const ctx = createMockContext({ errors: queryDataset.errors });
      const err = (await queryDataset
        .handler(queryDataset.input.parse({ datasetId: '235m-gsry', limit: 2 }), ctx)
        .catch((e) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain(APP_TOKEN);
    });

    it('keeps the app token out of an unreasoned failure, which reaches the caller with its data', async () => {
      /**
       * A status outside the reason ladder is rethrown untouched, so the service's own
       * `data` — including the request `url` and a slice of the response body — travels
       * to the client verbatim. This is the one path where a token placed in the URL
       * would ship, and the only reason the reasoned case above is not the whole test.
       */
      await withRealService(new Response('Unauthorized', { status: 401 }));
      const ctx = createMockContext({ errors: queryDataset.errors });
      const err = (await queryDataset
        .handler(queryDataset.input.parse({ datasetId: 'ab12-cd34', limit: 2 }), ctx)
        .catch((e) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      // The rethrow-unchanged path is what makes `data.url` reachable — pin it.
      expect((err.data as { url?: string }).url).toContain('/resource/ab12-cd34.json');
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain(APP_TOKEN);
    });
  });

  describe('cdc_query_wonder — input bounds', () => {
    /**
     * WONDER's request body is an XML document the builder assembles from these inputs, and
     * `cause_icd10` is the only free-text field that reaches it. The regex is the guard —
     * no markup character can pass input validation, so escaping downstream is a second
     * line rather than the only one.
     */
    const icd10Injections = [
      '</value></parameter><parameter><name>B_1</name><value>D76.V9',
      'I21<script>',
      'I21&amp;',
      "I21' or '1'='1",
      'i21', // lowercase — the code vocabulary is uppercase
      'I2', // too short
      '*All*',
      'I00-',
    ];

    it.each(icd10Injections)('rejects cause_icd10 %j', (cause) => {
      expect(() => queryWonder.input.parse({ cause_icd10: cause })).toThrow();
    });

    it('accepts a well-formed code and chapter range', () => {
      expect(queryWonder.input.parse({ cause_icd10: 'I21' }).cause_icd10).toBe('I21');
      expect(queryWonder.input.parse({ cause_icd10: 'C00-C97' }).cause_icd10).toBe('C00-C97');
      expect(queryWonder.input.parse({ cause_icd10: '' }).cause_icd10).toBe('');
    });

    it.each(['country', 'state', 'location', 'YEAR'])('rejects group_by value %j', (dim) => {
      expect(() => queryWonder.input.parse({ group_by: [dim] })).toThrow();
    });

    it('rejects an empty or oversized group_by list', () => {
      expect(() => queryWonder.input.parse({ group_by: [] })).toThrow();
      expect(() =>
        queryWonder.input.parse({ group_by: ['year', 'age_group', 'sex', 'race', 'year'] }),
      ).toThrow();
    });

    it.each([
      { from: 1998, to: 2000 },
      { from: 1999, to: 2021 },
      { from: 2010, to: 2005 },
    ])('rejects year_range %j', (range) => {
      expect(() => queryWonder.input.parse({ year_range: range })).toThrow();
    });

    it('exposes no host input, so there is no SSRF surface to allowlist', () => {
      /**
       * The Socrata tools guard a `domain` enum; WONDER reaches a single fixed host with no
       * caller-supplied component, and adding one would need the same allowlist treatment.
       */
      expect(Object.keys(queryWonder.input.shape)).not.toContain('domain');
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

    it('queryDataset format serializes a GeoJSON cell into its own column', () => {
      const geoValue = { type: 'Point', coordinates: [-73.93, 40.73] };
      const blocks = queryDataset.format!({
        rows: [{ location: geoValue, name: 'NYC' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      const dataRow = text.split('\n').find((l) => l.includes('NYC'));
      // The whole object renders in one cell, and the row keeps its two columns.
      expect(dataRow).toBe('| {"type":"Point","coordinates":[-73.93,40.73]} | NYC |');
    });

    it('queryDataset format renders null and undefined cells as blanks, not literals', () => {
      const blocks = queryDataset.format!({
        rows: [{ state: null, year: undefined, deaths: '100' }],
        rowCount: 1,
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      const dataRow = text.split('\n').find((l) => l.includes('100'));
      /**
       * Pin the whole rendered row: a nullish cell must occupy its column as an empty
       * cell so the value under `deaths` stays aligned with its header, and the words
       * "null"/"undefined" must never reach the caller as if they were data.
       */
      expect(dataRow).toBe('|  |  | 100 |');
      expect(dataRow).not.toContain('null');
      expect(dataRow).not.toContain('undefined');
    });
  });
});
