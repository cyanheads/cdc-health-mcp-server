/**
 * @fileoverview Tests for CDC server configuration.
 * @module tests/config/server-config
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listToolsBody } from '../helpers/tools-list.js';

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

describe('CDC_NORMALIZE_INPUT_CASE', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('CDC_NORMALIZE_INPUT_CASE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function normalizeInputCase(value: string | undefined) {
    vi.stubEnv('CDC_NORMALIZE_INPUT_CASE', value);
    const { getServerConfig } = await import('@/config/server-config.js');
    return getServerConfig().normalizeInputCase;
  }

  it.each([
    ['unset', undefined],
    ['blank', ''],
  ])('defaults to on when %s', async (_label, value) => {
    expect(await normalizeInputCase(value)).toBe(true);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['on', true],
    ['1', true],
    ['false', false],
    ['off', false],
    ['0', false],
    ['no', false],
  ])('reads %j as %s', async (value, expected) => {
    expect(await normalizeInputCase(value)).toBe(expected);
  });

  it('fails on a value that is not a boolean, naming the variable', async () => {
    await expect(normalizeInputCase('maybe')).rejects.toThrow(/CDC_NORMALIZE_INPUT_CASE/);
  });

  describe('the advertised tool schemas', () => {
    /** The patterns cause_icd10, mcd_icd10, and datasetId advertised before the switch existed. */
    const ICD10_PATTERN = '^[A-Z][0-9]{2}(\\.[0-9]+)?(-[A-Z][0-9]{2}(\\.[0-9]+)?)?$';
    const DATASET_ID_PATTERN = '^[a-z0-9]{4}-[a-z0-9]{4}$';

    /** The raw `tools/list` response body, from definitions loaded fresh under the current env. */
    async function toolsList(): Promise<string> {
      const [
        { discoverDatasets },
        { getDatasetSchema },
        { listCatalogVocabulary },
        { queryDataset },
        { queryWonder },
      ] = await Promise.all([
        import('@/mcp-server/tools/definitions/discover-datasets.tool.js'),
        import('@/mcp-server/tools/definitions/get-dataset-schema.tool.js'),
        import('@/mcp-server/tools/definitions/list-catalog-vocabulary.tool.js'),
        import('@/mcp-server/tools/definitions/query-dataset.tool.js'),
        import('@/mcp-server/tools/definitions/query-wonder.tool.js'),
      ]);
      return listToolsBody([
        discoverDatasets,
        getDatasetSchema,
        listCatalogVocabulary,
        queryDataset,
        queryWonder,
      ]);
    }

    /** Every `pattern` under one input property of one tool, in document order. */
    function patternsOf(body: string, tool: string, property: string): string[] {
      const json = body.slice(body.indexOf('{'));
      const { result } = JSON.parse(json) as {
        result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
      };
      const schema = result.tools.find((t) => t.name === tool)?.inputSchema.properties[property];
      return [...JSON.stringify(schema).matchAll(/"pattern":"((?:[^"\\]|\\.)*)"/g)].map(
        (m) => JSON.parse(`"${m[1]}"`) as string,
      );
    }

    it('is byte-identical with the switch on and off', async () => {
      vi.stubEnv('CDC_NORMALIZE_INPUT_CASE', 'true');
      const on = await toolsList();
      vi.resetModules();
      vi.stubEnv('CDC_NORMALIZE_INPUT_CASE', 'false');
      const off = await toolsList();

      expect(on).toContain('"tools":[');
      expect(off).toBe(on);
    });

    it('advertises the case-sensitive patterns it advertised before the switch', async () => {
      const body = await toolsList();
      // Each cause filter carries the code pattern twice: the single value and the list entry.
      expect(patternsOf(body, 'cdc_query_wonder', 'cause_icd10')).toEqual([
        ICD10_PATTERN,
        ICD10_PATTERN,
      ]);
      expect(patternsOf(body, 'cdc_query_wonder', 'mcd_icd10')).toEqual([
        ICD10_PATTERN,
        ICD10_PATTERN,
      ]);
      expect(patternsOf(body, 'cdc_get_dataset_schema', 'datasetId')).toEqual([DATASET_ID_PATTERN]);
      expect(patternsOf(body, 'cdc_query_dataset', 'datasetId')).toEqual([DATASET_ID_PATTERN]);
    });
  });
});
