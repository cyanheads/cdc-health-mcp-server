/**
 * @fileoverview Tests for CDC server configuration.
 * @module tests/config/server-config
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CDC_APP_TOKEN;
    delete process.env.CDC_BASE_URL;
    delete process.env.CDC_CATALOG_URL;
  });

  afterEach(() => {
    delete process.env.CDC_APP_TOKEN;
    delete process.env.CDC_BASE_URL;
    delete process.env.CDC_CATALOG_URL;
  });

  async function loadFresh() {
    const mod = await import('@/config/server-config.js');
    return mod.getServerConfig;
  }

  it('returns defaults when no env vars set', async () => {
    const getServerConfig = await loadFresh();
    const config = getServerConfig();
    expect(config.baseUrl).toBe('https://data.cdc.gov');
    expect(config.catalogUrl).toBe('https://api.us.socrata.com/api/catalog/v1');
    expect(config.appToken).toBeUndefined();
  });

  it('reads CDC_APP_TOKEN from environment', async () => {
    process.env.CDC_APP_TOKEN = 'test-token-123';
    const getServerConfig = await loadFresh();
    const config = getServerConfig();
    expect(config.appToken).toBe('test-token-123');
  });

  it('reads CDC_BASE_URL from environment', async () => {
    process.env.CDC_BASE_URL = 'https://custom.cdc.gov';
    const getServerConfig = await loadFresh();
    const config = getServerConfig();
    expect(config.baseUrl).toBe('https://custom.cdc.gov');
  });

  it('caches config on subsequent calls', async () => {
    const getServerConfig = await loadFresh();
    const first = getServerConfig();
    const second = getServerConfig();
    expect(first).toBe(second);
  });
});
