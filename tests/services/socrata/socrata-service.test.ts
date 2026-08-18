/**
 * @fileoverview Tests for Socrata SODA API client.
 * @module tests/services/socrata/socrata-service
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

function mockFetchError(status: number, body = '') {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

type FetchSpy = ReturnType<typeof mockFetch>;

/** URL the spy recorded on its first call. */
function firstUrl(spy: FetchSpy): string {
  const [call] = spy.mock.calls;
  if (!call) throw new Error('fetch was not called');
  return call[0] as string;
}

describe('SocrataService', () => {
  let service: SocrataService;

  beforeEach(() => {
    service = new SocrataService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('discover', () => {
    const catalogResponse = {
      results: [
        {
          resource: {
            id: 'bi63-dtpu',
            name: 'Diabetes Mortality',
            description: 'Diabetes death rates by state',
            columns_field_name: ['state', 'year', 'deaths'],
            columns_datatype: ['text', 'number', 'number'],
            data_updated_at: '2024-01-15T00:00:00.000Z',
            page_views: { page_views_total: 5000 },
          },
          classification: {
            domain_category: 'NCHS',
            domain_tags: ['diabetes', 'mortality'],
          },
        },
      ],
      resultSetSize: 1,
    };

    it('returns parsed datasets from catalog API', async () => {
      const spy = mockFetch(catalogResponse);
      const result = await service.discover({ query: 'diabetes' });

      expect(result.totalCount).toBe(1);
      expect(result.datasets).toHaveLength(1);
      expect(result.datasets[0]).toMatchObject({
        id: 'bi63-dtpu',
        name: 'Diabetes Mortality',
        category: 'NCHS',
        tags: ['diabetes', 'mortality'],
        columnNames: ['state', 'year', 'deaths'],
      });

      const url = firstUrl(spy);
      expect(url).toContain('domains=data.cdc.gov');
      expect(url).toContain('search_context=data.cdc.gov');
      expect(url).toContain('q=diabetes');
    });

    it('carries resource.type through as assetType for every catalog asset kind', async () => {
      /**
       * The catalog returns charts, maps, stories, files, and external links alongside
       * datasets, each with a four-by-four ID. Dropping resource.type left every one of
       * them looking identical to a queryable dataset.
       */
      mockFetch({
        results: [
          { resource: { id: 'bi63-dtpu', name: 'Leading Causes', type: 'dataset' } },
          { resource: { id: 's2qv-b27b', name: 'DHDS', type: 'filter' } },
          { resource: { id: 'sxbq-3sid', name: 'Pfizer Allocations', type: 'chart' } },
          { resource: { id: '235m-gsry', name: 'Pulmonary evaluation', type: 'file' } },
          { resource: { id: '2g2d-yfx9', name: 'trailheads', type: 'href' } },
        ],
        resultSetSize: 5,
      });
      const result = await service.discover({});

      expect(result.datasets.map((d) => [d.id, d.assetType])).toEqual([
        ['bi63-dtpu', 'dataset'],
        ['s2qv-b27b', 'filter'],
        ['sxbq-3sid', 'chart'],
        ['235m-gsry', 'file'],
        ['2g2d-yfx9', 'href'],
      ]);
    });

    it('omits assetType when the catalog entry carries no type', async () => {
      mockFetch({
        results: [{ resource: { id: 'ab12-cd34', name: 'Untyped' } }],
        resultSetSize: 1,
      });
      const result = await service.discover({});
      expect(result.datasets).toHaveLength(1);
      expect(result.datasets[0]?.assetType).toBeUndefined();
    });

    it('defaults the catalog domain to data.cdc.gov when none is given', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({});

      const url = firstUrl(spy);
      expect(url).toContain('domains=data.cdc.gov');
      expect(url).toContain('search_context=data.cdc.gov');
    });

    it('routes discovery to chronicdata.cdc.gov when domain is set', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ domain: 'chronicdata.cdc.gov', query: 'places' });

      const url = firstUrl(spy);
      expect(url).toContain('domains=chronicdata.cdc.gov');
      expect(url).toContain('search_context=chronicdata.cdc.gov');
      expect(url).not.toContain('domains=data.cdc.gov');
    });

    it('passes category and tags as query params', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ category: 'NNDSS', tags: ['covid19', 'surveillance'] });

      const url = firstUrl(spy);
      expect(url).toContain('categories=NNDSS');
      expect(url).toContain('tags=covid19');
      expect(url).toContain('tags=surveillance');
    });

    it('applies limit and offset', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ limit: 25, offset: 50 });

      const url = firstUrl(spy);
      expect(url).toContain('limit=25');
      expect(url).toContain('offset=50');
    });

    it('defaults limit to 10', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({});

      const url = firstUrl(spy);
      expect(url).toContain('limit=10');
    });

    it('forwards a requested order to the catalog URL for stable pagination', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ order: 'dataset_id' });

      const url = firstUrl(spy);
      expect(url).toContain('order=dataset_id');
    });

    it('forwards an explicit order override (relevance)', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ order: 'relevance' });

      const url = firstUrl(spy);
      expect(url).toContain('order=relevance');
    });

    it('omits the order param when no ordering is requested', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ limit: 50 });

      const url = firstUrl(spy);
      expect(url).not.toContain('order=');
    });
  });

  describe('getMetadata', () => {
    const metadataResponse = {
      name: 'Test Dataset',
      description: 'A test dataset',
      rowsUpdatedAt: 1717200000,
      columns: [
        {
          fieldName: 'state',
          dataTypeName: 'text',
          description: 'US state name',
          cachedContents: { count: '50000' },
        },
        { fieldName: 'year', dataTypeName: 'number', description: 'Data year' },
      ],
    };

    it('returns parsed metadata with columns', async () => {
      const spy = mockFetch(metadataResponse);
      const result = await service.getMetadata('bi63-dtpu');

      expect(result).toMatchObject({
        name: 'Test Dataset',
        description: 'A test dataset',
        rowCount: 50000,
        updatedAt: new Date(1717200000 * 1000).toISOString(),
      });
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0]).toMatchObject({
        fieldName: 'state',
        dataType: 'text',
        description: 'US state name',
      });

      const url = firstUrl(spy);
      expect(url).toBe('https://data.cdc.gov/api/views/bi63-dtpu.json');
    });

    it('routes metadata to chronicdata.cdc.gov when domain is set', async () => {
      const spy = mockFetch(metadataResponse);
      await service.getMetadata('swc5-untb', undefined, 'chronicdata.cdc.gov');

      const url = firstUrl(spy);
      expect(url).toBe('https://chronicdata.cdc.gov/api/views/swc5-untb.json');
    });

    it('throws on 404', async () => {
      mockFetchError(404);
      await expect(service.getMetadata('bi63-dtpu')).rejects.toThrow(/not found/);
    });

    it('throws on 429', async () => {
      mockFetchError(429);
      await expect(service.getMetadata('bi63-dtpu')).rejects.toThrow(/Rate limited/);
    });

    it('throws with status on other errors', async () => {
      mockFetchError(500, 'Internal Server Error');
      await expect(service.getMetadata('bi63-dtpu')).rejects.toThrow(/500/);
    });
  });

  describe('query', () => {
    const queryResponse = [
      { state: 'California', year: '2020', deaths: '5000' },
      { state: 'Texas', year: '2020', deaths: '4500' },
    ];

    it('returns rows and assembled query string', async () => {
      const spy = mockFetch(queryResponse);
      const result = await service.query({
        datasetId: 'bi63-dtpu',
        where: "state='California'",
        select: 'state, deaths',
        order: 'deaths DESC',
      });

      expect(result.rows).toHaveLength(2);
      expect(result.rowCount).toBe(2);
      expect(result.query).toContain('$where=state');
      expect(result.query).toContain('$select=state');
      expect(result.query).toContain('$order=deaths');

      const url = firstUrl(spy);
      expect(url).toContain('https://data.cdc.gov/resource/bi63-dtpu.json');
    });

    it('echoes each clause with its spaces intact so it can be replayed verbatim', async () => {
      /**
       * The echo exists to be lifted back into another call. `URLSearchParams` writes a
       * space as `+`, and `decodeURIComponent` leaves `+` alone, so echoing the decoded
       * wire string handed callers SoQL that Socrata rejects.
       */
      mockFetch(queryResponse);
      const result = await service.query({
        datasetId: 'bi63-dtpu',
        select: 'state, sum(deaths) as total_deaths',
        group: 'state',
        order: 'total_deaths DESC',
        limit: 3,
      });

      expect(result.query).toBe(
        '$select=state, sum(deaths) as total_deaths&$group=state&$order=total_deaths DESC&$limit=3&$offset=0',
      );
    });

    it('keeps a literal + a caller typed inside a clause', async () => {
      /**
       * Swapping every `+` for a space would fix the spaces and destroy the arithmetic:
       * `URLSearchParams` writes a caller's `+` as `%2B` and a space as `+`, so only
       * reading the values back off the params tells the two apart.
       */
      mockFetch(queryResponse);
      const result = await service.query({
        datasetId: 'bi63-dtpu',
        select: 'deaths + births as total',
        where: "year='2020'",
      });

      expect(result.query).toContain('$select=deaths + births as total');
      expect(result.query).toContain("$where=year='2020'");
    });

    it('still sends the encoded query on the wire', async () => {
      const spy = mockFetch(queryResponse);
      await service.query({ datasetId: 'bi63-dtpu', select: 'deaths + births as total' });

      const url = firstUrl(spy);
      expect(url).toContain('%24select=deaths+%2B+births+as+total');
    });

    it('routes queries to chronicdata.cdc.gov when domain is set', async () => {
      const spy = mockFetch(queryResponse);
      await service.query({
        datasetId: 'swc5-untb',
        domain: 'chronicdata.cdc.gov',
        where: "measureid='OBESITY' AND stateabbr='WA'",
      });

      const url = firstUrl(spy);
      expect(url).toContain('https://chronicdata.cdc.gov/resource/swc5-untb.json');
      expect(url.startsWith('https://chronicdata.cdc.gov/')).toBe(true);
    });

    it('passes search as $q parameter', async () => {
      const spy = mockFetch([]);
      await service.query({ datasetId: 'bi63-dtpu', search: 'diabetes' });

      const url = firstUrl(spy);
      expect(url).toContain('%24q=diabetes');
    });

    it('passes group and having clauses', async () => {
      const spy = mockFetch([]);
      await service.query({
        datasetId: 'bi63-dtpu',
        select: 'state, count(*)',
        group: 'state',
        having: 'count(*) > 10',
      });

      const url = firstUrl(spy);
      expect(url).toContain('%24group=state');
      expect(url).toContain('%24having=');
    });

    it('defaults limit to 100 and probes one row beyond it', async () => {
      const spy = mockFetch([]);
      const result = await service.query({ datasetId: 'bi63-dtpu', search: 'test' });

      // The wire carries the over-fetch probe...
      expect(firstUrl(spy)).toContain('%24limit=101');
      // ...while the echo carries the limit the caller actually asked for.
      expect(result.query).toContain('$limit=100');
    });

    it('over-fetches one row beyond an explicit limit to test for a further page', async () => {
      const spy = mockFetch([]);
      await service.query({ datasetId: 'bi63-dtpu', limit: 500, offset: 10 });

      const url = firstUrl(spy);
      expect(url).toContain('%24limit=501');
      expect(url).toContain('%24offset=10');
    });

    it('echoes the caller limit and offset, never the probe value', async () => {
      /**
       * The echo exists to be replayed. Handing back the probe's `$limit` would give a
       * caller who copies it one more row than they asked for on every subsequent call.
       */
      mockFetch([]);
      const result = await service.query({ datasetId: 'bi63-dtpu', limit: 3, offset: 6 });

      expect(result.query).toBe('$limit=3&$offset=6');
      expect(result.query).not.toContain('$limit=4');
    });

    it('trims the probe row off the result and reports hasMore', async () => {
      const rows = Array.from({ length: 4 }, (_, i) => ({ id: String(i) }));
      mockFetch(rows);
      const result = await service.query({ datasetId: 'bi63-dtpu', limit: 3 });

      expect(result.rows).toHaveLength(3);
      expect(result.rowCount).toBe(3);
      expect(result.hasMore).toBe(true);
    });

    it('reports hasMore false when the remaining rows exactly fill the limit', async () => {
      /**
       * The case the old `rowCount === limit` heuristic always called truncated. The probe
       * asked for 4 and got 3, which proves the result set ends here.
       */
      const rows = Array.from({ length: 3 }, (_, i) => ({ id: String(i) }));
      mockFetch(rows);
      const result = await service.query({ datasetId: 'bi63-dtpu', limit: 3 });

      expect(result.rows).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });

    it('reports hasMore false for a complete single-row aggregate', async () => {
      mockFetch([{ total_rows: '67463' }]);
      const result = await service.query({
        datasetId: 'akvg-8vrb',
        select: 'count(*) as total_rows',
        limit: 1,
      });

      expect(result.rowCount).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it('reports hasMore false for an empty result', async () => {
      mockFetch([]);
      const result = await service.query({ datasetId: 'bi63-dtpu', where: "state='Atlantis'" });

      expect(result.rows).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });
});
