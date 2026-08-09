/**
 * @fileoverview Pins what the `domain` input actually does: it chooses which of the two CDC
 * Socrata hosts answers a request, and nothing else. The hosts front one Socrata tenant — a
 * single catalog whose assets resolve by four-by-four ID on either — so a describe that names
 * PLACES, the Heart Disease & Stroke Atlas, or Environmental Public Health Tracking as though
 * `chronicdata.cdc.gov` were the way to reach them promises scoping the parameter has never
 * had. These tests assert both halves: the request differs only in the host selector, and no
 * `domain` describe carries an exclusivity claim.
 * @module tests/services/socrata/socrata-domain-semantics
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: undefined,
    baseUrl: 'https://data.cdc.gov',
    catalogUrl: 'https://api.us.socrata.com/api/catalog/v1',
  }),
}));

import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { SocrataService } from '@/services/socrata/socrata-service.js';
import { CDC_SOCRATA_DOMAINS } from '@/services/socrata/types.js';

/**
 * Each test issues one request per allowlisted host, and a `Response` body can only be read
 * once — so hand every call its own.
 */
function mockFetchEachCall(body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

const DOMAIN_DESCRIBES = [
  ['cdc_discover_datasets', discoverDatasets.input.shape.domain.description],
  ['cdc_get_dataset_schema', getDatasetSchema.input.shape.domain.description],
  ['cdc_query_dataset', queryDataset.input.shape.domain.description],
] as const;

describe('domain input semantics', () => {
  let service: SocrataService;

  beforeEach(() => {
    service = new SocrataService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('the request differs only in the host it addresses', () => {
    it('changes the catalog host selector and leaves every search filter alone', async () => {
      const spy = mockFetchEachCall({ results: [], resultSetSize: 0 });
      const options = { query: 'PLACES', category: 'Chronic Disease Indicators', limit: 20 };

      for (const domain of CDC_SOCRATA_DOMAINS) await service.discover({ ...options, domain });

      const [defaultParams, chronicParams] = spy.mock.calls.map(
        ([url]) => new URL(url as string).searchParams,
      );
      expect(defaultParams?.get('domains')).toBe('data.cdc.gov');
      expect(chronicParams?.get('domains')).toBe('chronicdata.cdc.gov');
      /**
       * Everything outside the two host-selector parameters must be identical. Discovery is
       * served by Socrata's cross-portal catalog, so the endpoint itself never changes either
       * — only which tenant the catalog is asked about.
       */
      const withoutHostSelector = (params: URLSearchParams) => {
        const rest = new URLSearchParams(params);
        rest.delete('domains');
        rest.delete('search_context');
        return rest.toString();
      };
      expect(withoutHostSelector(chronicParams!)).toBe(withoutHostSelector(defaultParams!));
      expect(spy.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
        'https://api.us.socrata.com/api/catalog/v1',
        'https://api.us.socrata.com/api/catalog/v1',
      ]);
    });

    it('sends the same dataset ID and the same SoQL to whichever host is named', async () => {
      const spy = mockFetchEachCall([]);
      const options = { datasetId: 'swc5-untb', where: "stateabbr='WA'", limit: 5 };

      for (const domain of CDC_SOCRATA_DOMAINS) await service.query({ ...options, domain });

      const [onDefault, onChronic] = spy.mock.calls.map(([url]) => new URL(url as string));
      expect(onDefault?.origin).toBe('https://data.cdc.gov');
      expect(onChronic?.origin).toBe('https://chronicdata.cdc.gov');
      // Same path, same query string — the ID is not scoped to a host.
      expect(onChronic?.pathname).toBe(onDefault?.pathname);
      expect(onChronic?.search).toBe(onDefault?.search);
    });
  });

  describe('no domain describe promises host-exclusive datasets', () => {
    it.each(DOMAIN_DESCRIBES)('%s names both hosts and says they share a catalog', (_, text) => {
      expect(text).toBeDefined();
      for (const domain of CDC_SOCRATA_DOMAINS) expect(text).toContain(domain);
      expect(text).toContain('front the same catalog');
    });

    it.each(DOMAIN_DESCRIBES)('%s does not tell the reader to match a host', (_, text) => {
      /**
       * The prose that sent callers switching hosts: a host described as *hosting* a named
       * collection, or an instruction to pick the host a dataset "lives on" / "was found on".
       * Both describe scoping the shared catalog does not do.
       */
      expect(text).not.toMatch(/hosts? chronic-disease/i);
      expect(text).not.toMatch(/must match the (portal|host|domain)/i);
      expect(text).not.toMatch(/(same|matching) (portal|host) (you|the dataset)/i);
    });

    it('cdc_discover_datasets names the chronic-disease collections as reachable from either host', () => {
      /**
       * Naming PLACES and its siblings is useful — they are the collections a reader comes
       * looking for. What made the old text wrong was attaching them to one host, so if they
       * are named at all, the sentence naming them has to say either host finds them.
       */
      const text = discoverDatasets.input.shape.domain.description!;
      expect(text).toContain('PLACES');
      expect(text).toContain('found from either');
    });
  });
});
