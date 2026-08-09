/**
 * @fileoverview Tests that the Socrata app token reaches the upstream request as a header and
 * reaches the caller nowhere. Socrata also accepts the credential as a `$$app_token` query
 * parameter, and that form leaks two ways the service cannot take back: through the
 * `effectiveQuery` echo on `QueryResult`, and through the request `url` the service attaches to
 * every error it throws, which the framework forwards to the client intact. Asserting absence
 * only proves something when the credential is genuinely on the path, so the config mock hands
 * the real service a sentinel and each assertion covers a surface the caller actually receives.
 * The service module is not mocked here, so `new SocrataService()` is the real implementation.
 * @module tests/services/socrata/socrata-service-token
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A value shaped like a real Socrata credential, distinctive enough to spot in any payload. */
const { APP_TOKEN } = vi.hoisted(() => ({ APP_TOKEN: 'cdc-app-tok-S3NT1NEL-never-ship' }));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: APP_TOKEN,
    baseUrl: 'https://data.cdc.gov',
    catalogUrl: 'https://api.us.socrata.com/api/catalog/v1',
  }),
}));

import { SocrataService } from '@/services/socrata/socrata-service.js';

describe('SocrataService — app token', () => {
  let service: SocrataService;

  beforeEach(() => {
    service = new SocrataService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Each case issues one request; every call gets its own body so none is read twice. */
  function mockFetchEachCall(body: unknown, status = 200) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  }

  const callsThatHitTheWire = [
    ['discover', (s: SocrataService) => s.discover({ query: 'diabetes' })],
    ['getMetadata', (s: SocrataService) => s.getMetadata('bi63-dtpu')],
    ['query', (s: SocrataService) => s.query({ datasetId: 'bi63-dtpu', where: 'year=2020' })],
  ] as const;

  it.each(callsThatHitTheWire)(
    '%s sends the token as a header and puts it nowhere in the request URL',
    async (_, call) => {
      const spy = mockFetchEachCall({ results: [], resultSetSize: 0, columns: [] });
      await call(service);

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-App-Token']).toBe(APP_TOKEN);
      expect(url).not.toContain(APP_TOKEN);
      expect(url).not.toContain('app_token');
    },
  );

  it('keeps the token out of the QueryResult it hands back', async () => {
    mockFetchEachCall([{ state: 'Texas', deaths: '100' }]);
    const result = await service.query({ datasetId: 'bi63-dtpu', where: 'year=2020' });

    /**
     * `query` echoes the assembled SoQL parameters verbatim, so a token added as one of them
     * would ride out with the clauses. Pin that the echo is populated before asserting on it —
     * an empty string trivially contains no token.
     */
    expect(result.query).toContain('$where=year=2020');
    expect(JSON.stringify(result)).not.toContain(APP_TOKEN);
  });

  it('keeps the token out of the DiscoverResult it hands back', async () => {
    mockFetchEachCall({
      results: [{ resource: { id: 'bi63-dtpu', name: 'Diabetes Mortality', type: 'dataset' } }],
      resultSetSize: 1,
    });
    const result = await service.discover({ query: 'diabetes' });

    expect(result.datasets).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(APP_TOKEN);
  });

  it.each(callsThatHitTheWire)(
    '%s keeps the token out of the error data the framework forwards to the client',
    async (_, call) => {
      mockFetchEachCall({ error: true }, 503);
      const err = (await call(service).catch((e) => e)) as McpError;

      /**
       * The 503 message is built from the status alone, so the message on its own can never
       * fail this. `data` is where a leak would actually land: the service attaches the request
       * `url` to every error it throws, and the framework forwards `data` intact. Pin that the
       * url is present, then assert on the whole serialized error.
       */
      expect((err.data as { url?: string }).url).toMatch(/^https:\/\//);
      expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain(APP_TOKEN);
    },
  );
});
