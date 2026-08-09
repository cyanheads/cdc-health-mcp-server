/**
 * @fileoverview Tests for the WONDER mortality service (HTTP, request spacing, error classification).
 * @module tests/services/wonder/wonder-service
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WonderService } from '@/services/wonder/wonder-service.js';

/**
 * The interval the service is configured to enforce, written out rather than imported: the
 * point of the spacing cases is that this number and the moment it is measured from are both
 * correct, which a value read back out of the implementation cannot show.
 */
const MIN_INTERVAL_MS = 16_000;

function mockFetch(body: string, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

const OK_TABLE = `<results><data-table>
  <r><c l="1999"/><c v="2,391,399"/><c v="279,040,168"/><c v="857.0"/><c v="875.6"/></r>
</data-table><caveats><caveat>A caveat.</caveat></caveats></results>`;

const FLAGGED_TABLE = `<results><data-table>
  <r><c l="1999"/><c v="10"/><c v="42,687,510"/><c v="Unreliable"/><c v="Suppressed"/></r>
</data-table><caveats><caveat>A caveat.</caveat><caveat>wonder:cmf-1('footnote')</caveat></caveats></results>`;

/** Three `<message>` elements as WONDER returns them on a 200 whose row set it filtered. */
const HIDDEN_ROWS_TABLE = `<results>
  <message><![CDATA[Totals are not available for these results due to suppression constraints. <a href="/wonder/help/faq.html#Privacy">More Information.</a>]]></message>
  <message>Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.</message>
  <message>Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.</message>
  <data-table>
  <r><c l="1999"/><c v="12"/><c v="279,040,168"/><c v="0.0"/><c v="0.0"/></r>
</data-table><caveats><caveat>A caveat.</caveat></caveats></results>`;

describe('WonderService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('POSTs form-urlencoded request_xml to the WONDER controller and parses rows', async () => {
    const spy = mockFetch(OK_TABLE);
    const service = new WonderService();
    const result = await service.query({ groupBy: ['year'] });

    expect(result.database).toBe('D76');
    expect(result.databaseTitle).toBe('Underlying Cause of Death, 1999-2020');
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      year: '1999',
      deaths: 2391399,
      age_adjusted_rate: 875.6,
    });
    expect(result.caveats).toEqual(['A caveat.']);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://wonder.cdc.gov/controller/datarequest/D76');
    expect(init.method).toBe('POST');
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain('request_xml=');
    expect(body).toContain('accept_datause_restrictions=true');
  });

  it('carries per-cell status tokens and filtered caveats through to the result', async () => {
    mockFetch(FLAGGED_TABLE);
    const service = new WonderService();
    const result = await service.query({ groupBy: ['year'] });

    expect(result.cellNotes).toEqual([
      { row: 0, column: 'crude_rate', token: 'Unreliable' },
      { row: 0, column: 'age_adjusted_rate', token: 'Suppressed' },
    ]);
    expect(result.suppressedCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ crude_rate: null, age_adjusted_rate: null });
    expect(result.caveats).toEqual(['A caveat.']);
  });

  it.each([
    ['provisional', 'D176', 'Provisional Mortality Statistics, 2018 through Last Week'],
    ['underlying_2018_2024', 'D158', 'Underlying Cause of Death, 2018-2024, Single Race'],
    ['multiple_1999_2020', 'D77', 'Multiple Cause of Death, 1999-2020'],
    ['multiple_2018_2024', 'D157', 'Multiple Cause of Death, 2018-2024, Single Race'],
  ] as const)(
    'posts %s to its own controller endpoint and reports it back',
    async (db, id, title) => {
      const spy = mockFetch(OK_TABLE);
      const service = new WonderService();
      const result = await service.query({ groupBy: ['year'], database: db });

      expect(spy.mock.calls[0]?.[0]).toBe(`https://wonder.cdc.gov/controller/datarequest/${id}`);
      expect(result.database).toBe(id);
      expect(result.databaseTitle).toBe(title);
    },
  );

  it('shares one request gate across databases, since WONDER limits by source IP', async () => {
    /**
     * A per-database limiter would let a D77 request follow a D176 response by 14 s, which
     * WONDER rejects with 429. The gap has to be instance-level and database-blind.
     */
    vi.useFakeTimers();
    const requestedAt: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      requestedAt.push(Date.now());
      return Promise.resolve(new Response(OK_TABLE, { status: 200 }));
    });

    const service = new WonderService();
    await service.query({ groupBy: ['year'], database: 'provisional' });

    const second = service.query({ groupBy: ['year'], database: 'multiple_1999_2020' });
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
    expect(requestedAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(requestedAt[1]! - requestedAt[0]!).toBe(MIN_INTERVAL_MS);
  });

  it('carries the informational messages from a successful response', async () => {
    mockFetch(HIDDEN_ROWS_TABLE);
    const service = new WonderService();
    const result = await service.query({ groupBy: ['year'] });

    expect(result.messages).toEqual([
      'Totals are not available for these results due to suppression constraints. More Information.',
      'Rows with zero Deaths are hidden. Use Quick Options above to show zero rows.',
      'Rows with suppressed Deaths are hidden. Use Quick Options above to show suppressed rows.',
    ]);
    expect(result.rowCount).toBe(1);
  });

  it('reports no messages when CDC withheld nothing', async () => {
    mockFetch(OK_TABLE);
    const service = new WonderService();
    expect((await service.query({ groupBy: ['year'] })).messages).toEqual([]);
  });

  it('spaces the next request from the end of the previous response, not from its start', async () => {
    /**
     * WONDER measures its window from the previous response, so spacing anchored on the
     * previous *request* fires early by however long that request took and draws a 429.
     */
    vi.useFakeTimers();
    const RESPONSE_MS = 2_000;
    const requestedAt: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      requestedAt.push(Date.now());
      return new Promise((resolve) => {
        setTimeout(() => resolve(new Response(OK_TABLE, { status: 200 })), RESPONSE_MS);
      });
    });

    const service = new WonderService();
    const first = service.query({ groupBy: ['year'] });
    await vi.advanceTimersByTimeAsync(RESPONSE_MS);
    await first;

    const second = service.query({ groupBy: ['year'] });
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
    expect(requestedAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(requestedAt).toHaveLength(2);
    expect(requestedAt[1]! - requestedAt[0]!).toBe(RESPONSE_MS + MIN_INTERVAL_MS);

    await vi.advanceTimersByTimeAsync(RESPONSE_MS);
    await expect(second).resolves.toMatchObject({ rowCount: 1 });
  });

  it('still spaces the next request after a failed one', async () => {
    /**
     * A request that threw still consumed the window. Stamping only where the response parses
     * would let the retry after a network error, a 429, or a malformed body fire unspaced.
     */
    vi.useFakeTimers();
    const requestedAt: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      requestedAt.push(Date.now());
      return requestedAt.length === 1
        ? Promise.reject(new Error('ECONNRESET'))
        : Promise.resolve(new Response(OK_TABLE, { status: 200 }));
    });

    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toMatchObject({
      data: { reason: 'upstream_error' },
    });

    const second = service.query({ groupBy: ['year'] });
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1);
    expect(requestedAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(requestedAt).toHaveLength(2);
    expect(requestedAt[1]! - requestedAt[0]!).toBe(MIN_INTERVAL_MS);
    await expect(second).resolves.toMatchObject({ rowCount: 1 });
  });

  it('classifies a 429 as a retryable rate-limit error', async () => {
    mockFetch('<message>Request rate exceeded.</message>', 429);
    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toMatchObject({
      data: { reason: 'rate_limited' },
    });
  });

  it('surfaces a WONDER validation message as an invalid_query error', async () => {
    mockFetch('<message>Invalid column name pop.</message>', 400);
    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toMatchObject({
      data: { reason: 'invalid_query' },
      message: expect.stringContaining('Invalid column name pop'),
    });
  });

  it('treats a bodyless non-2xx as an upstream error', async () => {
    mockFetch('', 502);
    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toMatchObject({
      data: { reason: 'upstream_error' },
    });
  });

  it('treats an Akamai "Access Denied" body as an upstream error', async () => {
    mockFetch('<HTML><H1>Access Denied</H1></HTML>', 403);
    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toMatchObject({
      data: { reason: 'upstream_error' },
    });
  });

  it('errors when a 200 response carries no data table', async () => {
    mockFetch('<results><message>Processing error.</message></results>', 200);
    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toThrow(/no data table/);
  });

  it('wraps a network failure as an upstream error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const service = new WonderService();
    await expect(service.query({ groupBy: ['year'] })).rejects.toMatchObject({
      data: { reason: 'upstream_error' },
    });
  });
});
