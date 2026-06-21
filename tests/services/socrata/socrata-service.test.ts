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

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('domains=data.cdc.gov');
      expect(url).toContain('search_context=data.cdc.gov');
      expect(url).toContain('q=diabetes');
    });

    it('defaults the catalog domain to data.cdc.gov when none is given', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({});

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('domains=data.cdc.gov');
      expect(url).toContain('search_context=data.cdc.gov');
    });

    it('routes discovery to chronicdata.cdc.gov when domain is set', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ domain: 'chronicdata.cdc.gov', query: 'places' });

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('domains=chronicdata.cdc.gov');
      expect(url).toContain('search_context=chronicdata.cdc.gov');
      expect(url).not.toContain('domains=data.cdc.gov');
    });

    it('passes category and tags as query params', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ category: 'NNDSS', tags: ['covid19', 'surveillance'] });

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('categories=NNDSS');
      expect(url).toContain('tags=covid19');
      expect(url).toContain('tags=surveillance');
    });

    it('applies limit and offset', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({ limit: 25, offset: 50 });

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('limit=25');
      expect(url).toContain('offset=50');
    });

    it('defaults limit to 10', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({});

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('limit=10');
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

      const url = spy.mock.calls[0][0] as string;
      expect(url).toBe('https://data.cdc.gov/api/views/bi63-dtpu.json');
    });

    it('routes metadata to chronicdata.cdc.gov when domain is set', async () => {
      const spy = mockFetch(metadataResponse);
      await service.getMetadata('swc5-untb', undefined, 'chronicdata.cdc.gov');

      const url = spy.mock.calls[0][0] as string;
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

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('https://data.cdc.gov/resource/bi63-dtpu.json');
    });

    it('routes queries to chronicdata.cdc.gov when domain is set', async () => {
      const spy = mockFetch(queryResponse);
      await service.query({
        datasetId: 'swc5-untb',
        domain: 'chronicdata.cdc.gov',
        where: "measureid='OBESITY' AND stateabbr='WA'",
      });

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('https://chronicdata.cdc.gov/resource/swc5-untb.json');
      expect(url.startsWith('https://chronicdata.cdc.gov/')).toBe(true);
    });

    it('passes search as $q parameter', async () => {
      const spy = mockFetch([]);
      await service.query({ datasetId: 'bi63-dtpu', search: 'diabetes' });

      const url = spy.mock.calls[0][0] as string;
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

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('%24group=state');
      expect(url).toContain('%24having=');
    });

    it('defaults limit to 100', async () => {
      const spy = mockFetch([]);
      await service.query({ datasetId: 'bi63-dtpu', search: 'test' });

      const url = spy.mock.calls[0][0] as string;
      expect(url).toContain('%24limit=100');
    });
  });
});
