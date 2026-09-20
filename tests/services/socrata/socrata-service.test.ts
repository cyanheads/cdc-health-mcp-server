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

/**
 * Route each request to its own outcome by matching a substring of the URL. `getMetadata`
 * issues the metadata read and the live `count(*)` together, so a single canned response
 * cannot express "metadata succeeded, the count did not".
 */
function mockFetchRoutes(
  routes: { match: string; respond: (init?: RequestInit) => Response | Promise<never> }[],
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return Promise.reject(new Error(`unrouted request: ${url}`));
    return Promise.resolve(route.respond(init));
  });
}

/** A request that never answers on its own and rejects only when its signal aborts, as fetch does. */
const stalledRequest = (init?: RequestInit): Promise<never> =>
  new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener('abort', fail);
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** URL of the first recorded call whose target contains `fragment`. */
function urlMatching(spy: FetchSpy, fragment: string): string {
  const match = spy.mock.calls.map((c) => c[0] as string).find((u) => u.includes(fragment));
  if (match === undefined) throw new Error(`no fetch matched ${fragment}`);
  return match;
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

  describe('vocabulary', () => {
    const categoryBody = {
      results: [
        { domain_category: 'Vaccinations', count: 89 },
        { domain_category: 'NNDSS', count: 295 },
      ],
      resultSetSize: 2,
    };

    it('reads categories from the catalog sibling endpoint for the requested domain', async () => {
      const spy = mockFetch(categoryBody);
      await service.listCategories('chronicdata.cdc.gov');

      const url = firstUrl(spy);
      expect(url).toContain('https://api.us.socrata.com/api/catalog/v1/domain_categories?');
      expect(url).toContain('domains=chronicdata.cdc.gov');
    });

    it('asks the tag endpoint for the whole vocabulary rather than its default page', async () => {
      /**
       * `domain_tags` answers a request that names no limit with 100 values and reports
       * `resultSetSize: 100` beside them, so the under-count reads as the whole vocabulary
       * and nothing downstream can tell it apart. The fix lives in the request, so this
       * asserts on the URL — a row count against a fixture would prove nothing about what
       * was asked for. The category endpoint sends no limit, which is what makes the
       * assertion discriminating rather than vacuous.
       */
      const tagSpy = mockFetch({
        results: [{ domain_tag: 'nndss', count: 294 }],
        resultSetSize: 1,
      });
      await service.listTags();
      const tagUrl = firstUrl(tagSpy);
      vi.restoreAllMocks();

      const categorySpy = mockFetch(categoryBody);
      await new SocrataService().listCategories();
      const categoryUrl = firstUrl(categorySpy);

      expect(tagUrl).toContain('/domain_tags?');
      expect(tagUrl).toContain('limit=10000');
      expect(categoryUrl).not.toContain('limit=');
    });

    it('defaults the domain to data.cdc.gov', async () => {
      const spy = mockFetch(categoryBody);
      await service.listCategories();

      expect(firstUrl(spy)).toContain('domains=data.cdc.gov');
    });

    it('ranks by entry count rather than trusting the order upstream sent', async () => {
      /**
       * Callers rank against this order — the near-miss notice names the most-used candidates
       * and the tag page's threshold bound assumes the last value shown is the smallest.
       */
      mockFetch(categoryBody);
      const terms = await service.listCategories();

      expect(terms).toEqual([
        { value: 'NNDSS', datasetCount: 295 },
        { value: 'Vaccinations', datasetCount: 89 },
      ]);
    });

    it('drops a row whose value or count is unusable instead of passing on a NaN', async () => {
      mockFetch({
        results: [
          { domain_tag: 'nndss', count: 294 },
          { domain_tag: '', count: 5 },
          { domain_tag: 'no-count' },
          { domain_tag: 'not-a-number', count: 'many' },
          { count: 7 },
        ],
        resultSetSize: 5,
      });
      const terms = await service.listTags();

      expect(terms).toEqual([{ value: 'nndss', datasetCount: 294 }]);
    });

    it('returns an empty vocabulary when the endpoint carries no results key', async () => {
      mockFetch({ resultSetSize: 0 });

      await expect(service.listTags()).resolves.toEqual([]);
    });

    it('lets a catalog failure out with its reason rather than an empty vocabulary', async () => {
      /**
       * An empty list and an outage read identically to a caller, and a near-miss notice
       * built on one would silently claim nothing in the catalog is close.
       */
      mockFetchError(429);

      await expect(service.listTags()).rejects.toMatchObject({
        data: { reason: 'rate_limited' },
      });
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

    describe('description as plain text', () => {
      const withDescription = (description: string) => ({
        name: 'Test Dataset',
        description,
        columns: [{ fieldName: 'state', dataTypeName: 'text' }],
      });

      it('returns the description with markup removed and entities decoded, whole', async () => {
        const body =
          '<p style="margin:0in;"><strong>Deaths</strong> per 100,000 &amp; population.</p>' +
          `<span>${'D'.repeat(600)}</span>`;
        mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(withDescription(body)) },
          { match: '/resource/', respond: () => jsonResponse([{ count: '10' }]) },
        ]);
        const result = await service.getMetadata('bi63-dtpu');

        expect(result.description).toBe(`Deaths per 100,000 & population. ${'D'.repeat(600)}`);
        expect(result.description).not.toContain('<');
      });

      it('decodes an escaped entity exactly once', async () => {
        mockFetchRoutes([
          {
            match: '/api/views/',
            respond: () => jsonResponse(withDescription('Ages &amp;lt;1 &amp; over.')),
          },
          { match: '/resource/', respond: () => jsonResponse([{ count: '10' }]) },
        ]);
        const result = await service.getMetadata('bi63-dtpu');
        expect(result.description).toBe('Ages &lt;1 & over.');
      });

      it('omits the description when it is markup with no text in it', async () => {
        mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(withDescription('<p></p>  ')) },
          { match: '/resource/', respond: () => jsonResponse([{ count: '10' }]) },
        ]);
        const result = await service.getMetadata('bi63-dtpu');
        expect(result.description).toBeUndefined();
      });
    });

    describe('live row count', () => {
      const cachedCountMetadata = {
        name: 'COVID-19 Case Surveillance',
        columns: [
          { fieldName: 'state', dataTypeName: 'text', cachedContents: { count: '139968' } },
          { fieldName: 'year', dataTypeName: 'number' },
        ],
      };

      it('reports the live count(*) rather than the cached figure', async () => {
        /**
         * Socrata builds `cachedContents.count` once and never refreshes it, so on an
         * actively-updated dataset the cached figure understates the real total and a
         * caller sizing a pagination walk against it stops early.
         */
        const spy = mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => jsonResponse([{ count: '218700' }]) },
        ]);
        const result = await service.getMetadata('4va6-ph5s');

        expect(result.rowCount).toBe(218700);
        expect(result.rowCountSource).toBe('live');
        expect(spy).toHaveBeenCalledTimes(2);
      });

      it('sends count(*) with no other projection and no filters', async () => {
        /**
         * `$select=state,count(*)&$group=state` answers a different question — a count per
         * state, not the dataset total — so the count request must project nothing else.
         */
        const spy = mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => jsonResponse([{ count: '218700' }]) },
        ]);
        await service.getMetadata('4va6-ph5s');

        const countUrl = urlMatching(spy, '/resource/');
        const params = new URL(countUrl).searchParams;
        expect(params.get('$select')).toBe('count(*)');
        expect([...params.keys()]).toEqual(['$select']);
        expect(countUrl.startsWith('https://data.cdc.gov/resource/4va6-ph5s.json?')).toBe(true);
      });

      it('routes the count to the same allowlisted host as the metadata read', async () => {
        const spy = mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => jsonResponse([{ count: '9' }]) },
        ]);
        await service.getMetadata('swc5-untb', undefined, 'chronicdata.cdc.gov');

        expect(urlMatching(spy, '/resource/').startsWith('https://chronicdata.cdc.gov/')).toBe(
          true,
        );
      });

      it('falls back to the cached figure and says so when the count request fails', async () => {
        const spy = mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => jsonResponse({ error: true }, 500) },
        ]);
        const result = await service.getMetadata('4va6-ph5s');

        expect(result.name).toBe('COVID-19 Case Surveillance');
        expect(result.rowCount).toBe(139968);
        expect(result.rowCountSource).toBe('cached');
        expect(spy).toHaveBeenCalledTimes(2);
      });

      it('still answers when the count request rejects at the network layer', async () => {
        /**
         * The count annotates the schema response; it must never be able to fail or hang
         * the response it annotates.
         */
        mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => Promise.reject(new TypeError('fetch failed')) },
        ]);
        const result = await service.getMetadata('4va6-ph5s');

        expect(result.columns).toHaveLength(2);
        expect(result.rowCount).toBe(139968);
        expect(result.rowCountSource).toBe('cached');
      });

      it('gives up on a stalled count instead of holding the schema response open', async () => {
        /**
         * The metadata document has already arrived by then. Waiting on an annotation that
         * may never answer turns an optional extra into a hang of the response it annotates,
         * so the count carries a deadline of its own and the request is cancelled with it.
         */
        vi.useFakeTimers();
        try {
          mockFetchRoutes([
            { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
            { match: '/resource/', respond: stalledRequest },
          ]);
          const pending = service.getMetadata('4va6-ph5s');
          await vi.advanceTimersByTimeAsync(60_000);
          const result = await pending;

          expect(result.rowCount).toBe(139968);
          expect(result.rowCountSource).toBe('cached');
          expect(result.columns).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it('cancels an in-flight count when the caller aborts mid-request', async () => {
        /** A cancelled tool call must not leave the annotation's request running behind it. */
        const controller = new AbortController();
        let countSignal: AbortSignal | undefined;
        mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          {
            match: '/resource/',
            respond: (init) => {
              countSignal = init?.signal ?? undefined;
              // Register the listener first, then cancel — as a real in-flight abort arrives.
              const inFlight = stalledRequest(init);
              controller.abort();
              return inFlight;
            },
          },
        ]);
        const result = await service.getMetadata('4va6-ph5s', controller.signal);

        expect(countSignal?.aborted).toBe(true);
        expect(result.rowCountSource).toBe('cached');
      });

      it('supplies a row count for an asset that carries no cached count at all', async () => {
        /** A `filter` asset has real columns and queries fine, but no cachedContents.count. */
        mockFetchRoutes([
          {
            match: '/api/views/',
            respond: () =>
              jsonResponse({
                name: 'DHDS',
                columns: [{ fieldName: 'year', dataTypeName: 'text' }],
              }),
          },
          { match: '/resource/', respond: () => jsonResponse([{ count: '3592' }]) },
        ]);
        const result = await service.getMetadata('s2qv-b27b');

        expect(result.rowCount).toBe(3592);
        expect(result.rowCountSource).toBe('live');
      });

      it('omits rowCount entirely when neither the cache nor the count supplies one', async () => {
        mockFetchRoutes([
          {
            match: '/api/views/',
            respond: () =>
              jsonResponse({
                name: 'DHDS',
                columns: [{ fieldName: 'year', dataTypeName: 'text' }],
              }),
          },
          { match: '/resource/', respond: () => jsonResponse({ error: true }, 500) },
        ]);
        const result = await service.getMetadata('s2qv-b27b');

        expect(result.rowCount).toBeUndefined();
        expect(result.rowCountSource).toBeUndefined();
      });

      it('ignores a count body that is not a row carrying a number', async () => {
        mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => jsonResponse([]) },
        ]);
        const result = await service.getMetadata('4va6-ph5s');

        expect(result.rowCount).toBe(139968);
        expect(result.rowCountSource).toBe('cached');
      });

      it('skips the count request when the caller asks for metadata alone', async () => {
        /**
         * `cdc_query_dataset`'s queryability probe needs the column list and nothing else;
         * spending a second upstream request on a row total it discards is waste on a path
         * that already answered the caller badly.
         */
        const spy = mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse(cachedCountMetadata) },
          { match: '/resource/', respond: () => jsonResponse([{ count: '218700' }]) },
        ]);
        const result = await service.getMetadata('4va6-ph5s', undefined, undefined, {
          liveRowCount: false,
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(urlMatching(spy, '/api/views/')).toContain('4va6-ph5s');
        expect(result.rowCount).toBe(139968);
        expect(result.rowCountSource).toBe('cached');
      });

      it('rethrows the metadata failure rather than a count failure', async () => {
        mockFetchRoutes([
          { match: '/api/views/', respond: () => jsonResponse({ error: true }, 404) },
          { match: '/resource/', respond: () => jsonResponse({ error: true }, 500) },
        ]);
        await expect(service.getMetadata('ab12-cd34')).rejects.toThrow(/not found/i);
      });
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
