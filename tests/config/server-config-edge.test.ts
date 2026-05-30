/**
 * @fileoverview Edge-case tests for server-config: URL validation, CDC_CATALOG_URL env var.
 * @module tests/config/server-config-edge
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getServerConfig — edge cases', () => {
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

  it('reads CDC_CATALOG_URL from environment', async () => {
    process.env.CDC_CATALOG_URL = 'https://custom-catalog.example.com/api';
    const getServerConfig = await loadFresh();
    const config = getServerConfig();
    expect(config.catalogUrl).toBe('https://custom-catalog.example.com/api');
  });

  it('throws on invalid CDC_BASE_URL (not a URL)', async () => {
    process.env.CDC_BASE_URL = 'not-a-url';
    const getServerConfig = await loadFresh();
    expect(() => getServerConfig()).toThrow();
  });

  it('throws on invalid CDC_CATALOG_URL (not a URL)', async () => {
    process.env.CDC_CATALOG_URL = 'not-a-url';
    const getServerConfig = await loadFresh();
    expect(() => getServerConfig()).toThrow();
  });

  it('accepts https URL for CDC_BASE_URL', async () => {
    process.env.CDC_BASE_URL = 'https://data.cdc.gov';
    const getServerConfig = await loadFresh();
    const config = getServerConfig();
    expect(config.baseUrl).toBe('https://data.cdc.gov');
  });

  it('returns undefined for appToken when not set', async () => {
    const getServerConfig = await loadFresh();
    const config = getServerConfig();
    expect(config.appToken).toBeUndefined();
  });
});
