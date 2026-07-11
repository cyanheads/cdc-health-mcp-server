/**
 * @fileoverview Tests for the WONDER mortality service (HTTP + error classification).
 * @module tests/services/wonder/wonder-service
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WonderService } from '@/services/wonder/wonder-service.js';

function mockFetch(body: string, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

const OK_TABLE = `<results><data-table>
  <r><c l="1999"/><c v="2,391,399"/><c v="279,040,168"/><c v="857.0"/><c v="875.6"/></r>
</data-table><caveats><caveat>A caveat.</caveat></caveats></results>`;

describe('WonderService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs form-urlencoded request_xml to the WONDER controller and parses rows', async () => {
    const spy = mockFetch(OK_TABLE);
    const service = new WonderService();
    const result = await service.query({ groupBy: ['year'] });

    expect(result.database).toBe('D76');
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
    // One call only — a fresh service does not throttle, but a second call would wait 15s.
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
