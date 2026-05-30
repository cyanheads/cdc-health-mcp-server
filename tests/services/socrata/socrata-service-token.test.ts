/**
 * @fileoverview Tests for SocrataService app token header injection.
 * @module tests/services/socrata/socrata-service-token
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: 'my-app-token',
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

  it('sends X-App-Token header when appToken is set', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ results: [], resultSetSize: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await service.discover({});
    const headers = spy.mock.calls[0][1]?.headers as Record<string, string> | undefined;
    expect(headers?.['X-App-Token']).toBe('my-app-token');
  });

  it('does not expose app token in response or error output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    let caughtMessage = '';
    try {
      await service.discover({});
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).not.toContain('my-app-token');
  });
});
