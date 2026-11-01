/**
 * @fileoverview Tests for the SocrataService failures that arrive without a usable status: a
 * request that never reaches a response, a 2xx body that cannot be read, a request that runs
 * past its deadline, and the caller's own cancellation.
 * @module tests/services/socrata/socrata-service-failures
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: undefined,
    baseUrl: 'https://data.cdc.gov',
    catalogUrl: 'https://api.us.socrata.com/api/catalog/v1',
  }),
}));

import { SocrataService } from '@/services/socrata/socrata-service.js';

type Respond = (init: RequestInit | undefined, url: string) => Response | Promise<Response>;

/** Every request answered by `respond`, each with a fresh `Response` — a body reads once. */
function serve(respond: Respond) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => Promise.resolve(respond(init, String(input))));
}

/** A request that never answers, and rejects with its signal's reason when that aborts — as fetch does. */
function stalled(init: RequestInit | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const fail = () => reject(signal?.reason);
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail);
  });
}

/**
 * Headers now, one chunk of body, then nothing more until the request's signal aborts, which
 * errors the stream with the signal's reason as a real fetch body does. `onPull` runs when the
 * reader asks for the chunk that never comes — the body read is then in flight.
 */
function stallingBody(init: RequestInit | undefined, onPull?: () => void): Response {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
      const signal = init?.signal;
      const fail = () => controller.error(signal?.reason);
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail);
    },
    pull() {
      if (pulled) return;
      pulled = true;
      onPull?.();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Settlement of a promise, readable synchronously between fake-timer steps. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

type Call = (service: SocrataService, signal?: AbortSignal) => Promise<unknown>;

/** Every public read, each over the request the six Socrata definitions reach it through. */
const METHODS: { name: string; call: Call }[] = [
  { name: 'discover', call: (s, signal) => s.discover({ query: 'influenza' }, signal) },
  { name: 'listCategories', call: (s, signal) => s.listCategories(undefined, signal) },
  { name: 'listTags', call: (s, signal) => s.listTags(undefined, signal) },
  { name: 'getMetadata', call: (s, signal) => s.getMetadata('ab12-cd34', signal) },
  { name: 'query', call: (s, signal) => s.query({ datasetId: 'ab12-cd34' }, signal) },
];

/** 2xx bodies none of the endpoints can be read from. */
const UNREADABLE: { name: string; respond: () => Response }[] = [
  {
    name: 'an HTML page',
    respond: () =>
      new Response('<html><body><h1>Service maintenance</h1></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
  },
  {
    name: 'truncated JSON',
    respond: () =>
      new Response('{"results":[{"resource":{"id":"ab12-cd34","name":"Trunc', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
  { name: '{"message":"ok"}', respond: () => Response.json({ message: 'ok' }) },
  { name: 'an empty object', respond: () => Response.json({}) },
];

const CASES = METHODS.flatMap((method) => UNREADABLE.map((body) => ({ ...method, body })));

async function upstreamError(promise: Promise<unknown>): Promise<McpError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpError);
  const mcp = err as McpError;
  expect(mcp.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  expect(mcp.data).toMatchObject({ reason: 'upstream_error' });
  return mcp;
}

describe('SocrataService — failures without a usable status', () => {
  let service: SocrataService;

  beforeEach(() => {
    service = new SocrataService();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('a request that never reaches a response', () => {
    it.each(METHODS)('reasons a network failure in $name as upstream_error', async ({ call }) => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      const err = await upstreamError(call(service));
      expect(err.message).not.toContain('fetch failed');
    });

    it('reasons a refused connection as upstream_error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Object.assign(new Error('ECONNREFUSED: Unable to connect'), { code: 'ECONNREFUSED' }),
      );
      await upstreamError(service.query({ datasetId: 'ab12-cd34' }));
    });

    it.each(METHODS)(
      'reasons a body cut off after its headers in $name as upstream_error',
      async ({ call }) => {
        serve(
          () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"results":['));
                  controller.error(new TypeError('terminated'));
                },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        await upstreamError(call(service));
      },
    );
  });

  describe('a 2xx body that cannot be read', () => {
    it.each(CASES)('reasons $body.name from $name as upstream_error', async ({ call, body }) => {
      serve(body.respond);
      await upstreamError(call(service));
    });

    it.each([
      ['a result without an id', { results: [{ resource: { name: 'No ID' } }], resultSetSize: 1 }],
      ['a result without a resource', { results: [{ classification: {} }], resultSetSize: 1 }],
      ['no results key', { resultSetSize: 0 }],
      ['no resultSetSize', { results: [] }],
      ['a resultSetSize that is not a number', { results: [], resultSetSize: '0' }],
    ])('rejects a catalog page with %s rather than reading it as data', async (_name, body) => {
      serve(() => Response.json(body));
      await upstreamError(service.discover({ query: 'influenza' }));
    });

    it.each([
      ['results that are not a list', { results: { domain_tag: 'covid19', count: 1 } }],
      ['a row that is not an object', { results: ['covid19'] }],
    ])('rejects a vocabulary body with %s rather than an empty vocabulary', async (_name, body) => {
      serve(() => Response.json(body));
      await upstreamError(service.listTags());
    });

    it.each([
      ['no columns', { name: 'Untitled' }],
      ['no name', { columns: [] }],
      ['columns that are not a list', { name: 'Untitled', columns: {} }],
      ['a column without a fieldName', { name: 'Untitled', columns: [{ dataTypeName: 'text' }] }],
    ])('rejects a metadata document with %s rather than an empty schema', async (_name, body) => {
      serve((_init, url) =>
        url.includes('/api/views/') ? Response.json(body) : Response.json([{ count: '1' }]),
      );
      await upstreamError(service.getMetadata('ab12-cd34'));
    });

    it.each([
      ['an object', { rows: [] }],
      ['a list of non-objects', [1, 2]],
    ])('rejects a data page that is %s rather than iterating it', async (_name, body) => {
      serve(() => Response.json(body));
      await upstreamError(service.query({ datasetId: 'ab12-cd34' }));
    });
  });

  describe('bodies the schemas accept', () => {
    it('reads a real empty catalog page as an empty page, not a failure', async () => {
      serve(() => Response.json({ results: [], resultSetSize: 0 }));
      await expect(service.discover({ query: 'nothing' })).resolves.toEqual({
        datasets: [],
        totalCount: 0,
      });
    });

    it('reads the nulls the live catalog sends for absent fields as absent', async () => {
      /** 37 of the 1,479 live catalog entries carry `domain_category: null`. */
      serve(() =>
        Response.json({
          results: [
            {
              resource: {
                id: 'ab12-cd34',
                name: 'Sparse',
                description: null,
                type: 'dataset',
                columns_field_name: ['year'],
                columns_datatype: ['number'],
                data_updated_at: null,
                page_views: null,
              },
              classification: { domain_category: null, domain_tags: [] },
            },
          ],
          resultSetSize: 1,
        }),
      );
      const { datasets } = await service.discover({});
      expect(datasets).toEqual([
        {
          id: 'ab12-cd34',
          name: 'Sparse',
          assetType: 'dataset',
          tags: [],
          columnNames: ['year'],
          columnTypes: ['number'],
        },
      ]);
    });

    it('reads a chart document, whose columns are empty, as a schema with no columns', async () => {
      serve((_init, url) =>
        url.includes('/api/views/')
          ? Response.json({ id: '2r93-e5cs', name: 'A Chart', description: null, columns: [] })
          : Response.json([{}]),
      );
      const metadata = await service.getMetadata('2r93-e5cs');
      expect(metadata).toEqual({ name: 'A Chart', columns: [] });
    });

    it('reads a column whose description is null as a column with none', async () => {
      serve((_init, url) =>
        url.includes('/api/views/')
          ? Response.json({
              name: 'Real',
              columns: [
                {
                  fieldName: 'year',
                  dataTypeName: 'number',
                  description: null,
                  cachedContents: null,
                },
              ],
            })
          : Response.json([{ count: '10868' }]),
      );
      const metadata = await service.getMetadata('bi63-dtpu');
      expect(metadata).toEqual({
        name: 'Real',
        columns: [{ fieldName: 'year', dataType: 'number' }],
        rowCount: 10868,
        rowCountSource: 'live',
      });
    });
  });

  describe('deadline', () => {
    it.each(METHODS)(
      'abandons $name when headers never arrive, at 20 seconds and not before',
      async ({ call }) => {
        vi.useFakeTimers();
        serve((init) => stalled(init));
        const pending = track(call(service));

        await vi.advanceTimersByTimeAsync(19_999);
        expect(pending.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(pending.settled).toBe(true);

        const err = await upstreamError(Promise.reject(pending.error));
        expect(err.message).toContain('within 20 seconds');
      },
    );

    it.each(METHODS)('abandons $name when the body stalls after its headers', async ({ call }) => {
      vi.useFakeTimers();
      serve((init) => stallingBody(init));
      const pending = track(call(service));

      await vi.advanceTimersByTimeAsync(19_999);
      expect(pending.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await upstreamError(Promise.reject(pending.error));
      expect(err.message).toContain('within 20 seconds');
    });

    it('tells a data query that narrowing it answers sooner', async () => {
      vi.useFakeTimers();
      serve((init) => stalled(init));
      const pending = track(service.query({ datasetId: 'ab12-cd34' }));
      await vi.advanceTimersByTimeAsync(20_000);

      const err = await upstreamError(Promise.reject(pending.error));
      expect(err.message).toContain(
        'A narrower where or select, or a smaller limit, answers sooner',
      );
    });

    it('gives the catalog no query advice it cannot act on', async () => {
      vi.useFakeTimers();
      serve((init) => stalled(init));
      const pending = track(service.discover({ query: 'influenza' }));
      await vi.advanceTimersByTimeAsync(20_000);

      const err = await upstreamError(Promise.reject(pending.error));
      expect(err.message).not.toMatch(/where|select|limit/);
    });

    it('leaves no timer behind after a request that answered', async () => {
      vi.useFakeTimers();
      serve(() => Response.json([{ state: 'Texas' }]));
      await expect(service.query({ datasetId: 'ab12-cd34' })).resolves.toMatchObject({
        rowCount: 1,
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind after a request that failed by status', async () => {
      vi.useFakeTimers();
      serve(() => new Response('Server error', { status: 503 }));
      await upstreamError(service.query({ datasetId: 'ab12-cd34' }));
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still classifies a 429 whose error body stalls by its status', async () => {
      vi.useFakeTimers();
      serve((init) => {
        const stalledBody = stallingBody(init);
        return new Response(stalledBody.body, { status: 429 });
      });
      const pending = track(service.query({ datasetId: 'ab12-cd34' }));
      await vi.advanceTimersByTimeAsync(20_000);

      expect(pending.error).toBeInstanceOf(McpError);
      expect((pending.error as McpError).data).toMatchObject({ reason: 'rate_limited' });
    });
  });

  describe('the live row count keeps its own 5-second deadline', () => {
    const cachedCountMetadata = {
      name: 'COVID-19 Case Surveillance',
      columns: [{ fieldName: 'state', dataTypeName: 'text', cachedContents: { count: '139968' } }],
    };

    it('falls back to the cached figure 5 seconds after the count is sent, not before', async () => {
      vi.useFakeTimers();
      let countSent = false;
      serve((init, url) => {
        if (url.includes('/api/views/')) return Response.json(cachedCountMetadata);
        countSent = true;
        return stalled(init);
      });
      const pending = track(service.getMetadata('4va6-ph5s'));

      // The count is the second request, sent once the 250 ms spacing has passed.
      await vi.advanceTimersByTimeAsync(250);
      expect(countSent).toBe(true);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pending.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(pending.value).toMatchObject({ rowCount: 139968, rowCountSource: 'cached' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ['an HTML page', () => new Response('<html></html>', { status: 200 })],
      ['{"message":"ok"}', () => Response.json({ message: 'ok' })],
      ['a body cut off after its headers', () => new Response('[{"count":"1', { status: 200 })],
      ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ] as const)('falls back to the cached figure on %s', async (_name, count) => {
      serve((_init, url) =>
        url.includes('/api/views/') ? Response.json(cachedCountMetadata) : count(),
      );
      await expect(service.getMetadata('4va6-ph5s')).resolves.toMatchObject({
        rowCount: 139968,
        rowCountSource: 'cached',
      });
    });
  });

  describe('caller cancellation', () => {
    it.each(METHODS)(
      'rethrows the caller abort from $name unchanged while headers are awaited',
      async ({ call }) => {
        const controller = new AbortController();
        const reason = new Error('caller went away');
        serve((init) => {
          const inFlight = stalled(init);
          controller.abort(reason);
          return inFlight;
        });

        const err = await call(service, controller.signal).catch((e: unknown) => e);
        expect(err).toBe(reason);
      },
    );

    it.each(METHODS)(
      'rethrows the caller abort from $name unchanged while the body is read',
      async ({ call }) => {
        const controller = new AbortController();
        const reason = new Error('caller went away mid-body');
        serve((init) => stallingBody(init, () => controller.abort(reason)));

        const err = await call(service, controller.signal).catch((e: unknown) => e);
        expect(err).toBe(reason);
      },
    );
  });
});
