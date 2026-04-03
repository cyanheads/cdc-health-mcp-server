/**
 * @fileoverview Socrata SODA API client for CDC Open Data portal.
 * Handles discovery, metadata, and SoQL queries with rate-limit-aware request spacing.
 * @module services/socrata/socrata-service
 */

import { getServerConfig } from '@/config/server-config.js';
import type {
  CatalogDataset,
  DatasetColumn,
  DatasetMetadata,
  DiscoverResult,
  QueryResult,
} from './types.js';

const DATASET_ID_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
const MIN_REQUEST_INTERVAL_MS = 250;

/** Options for discovering datasets. */
export interface DiscoverOptions {
  category?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  query?: string | undefined;
  tags?: string[] | undefined;
}

/** Options for querying a dataset via SoQL. */
export interface QueryOptions {
  datasetId: string;
  group?: string | undefined;
  having?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  order?: string | undefined;
  search?: string | undefined;
  select?: string | undefined;
  where?: string | undefined;
}

export class SocrataService {
  private lastRequestTime = 0;

  /**
   * Search the CDC dataset catalog by keyword, category, or tag.
   */
  async discover(options: DiscoverOptions, signal?: AbortSignal): Promise<DiscoverResult> {
    const config = getServerConfig();
    const params = new URLSearchParams({
      domains: 'data.cdc.gov',
      search_context: 'data.cdc.gov',
    });

    if (options.query) params.set('q', options.query);
    if (options.category) params.set('categories', options.category);
    if (options.tags) {
      for (const tag of options.tags) params.append('tags', tag);
    }
    params.set('limit', String(options.limit ?? 10));
    if (options.offset) params.set('offset', String(options.offset));

    const url = `${config.catalogUrl}?${params}`;
    const data = await this.fetchJson(url, signal);

    const results = (data.results ?? []) as Record<string, unknown>[];
    const datasets: CatalogDataset[] = results.map((r) => {
      const resource = r.resource as Record<string, unknown>;
      const classification = r.classification as Record<string, unknown>;
      return {
        id: resource.id as string,
        name: resource.name as string,
        description: resource.description as string,
        category: (classification?.domain_category as string) ?? '',
        tags: (classification?.domain_tags as string[]) ?? [],
        columnNames: (resource.columns_field_name as string[]) ?? [],
        columnTypes: (resource.columns_datatype as string[]) ?? [],
        updatedAt: resource.data_updated_at as string,
        pageViews: (resource.page_views as Record<string, number>)?.page_views_total ?? 0,
      };
    });

    return { datasets, totalCount: (data.resultSetSize as number) ?? 0 };
  }

  /**
   * Fetch full metadata and column schema for a dataset.
   */
  async getMetadata(datasetId: string, signal?: AbortSignal): Promise<DatasetMetadata> {
    this.validateDatasetId(datasetId);
    const config = getServerConfig();
    const url = `${config.baseUrl}/api/views/${datasetId}.json`;
    const data = await this.fetchJson(url, signal);

    const columns: DatasetColumn[] = ((data.columns as Record<string, unknown>[]) ?? []).map(
      (col) => ({
        fieldName: (col.fieldName as string) ?? '',
        dataType: (col.dataTypeName as string) ?? '',
        description: (col.description as string) ?? '',
      }),
    );

    const rawColumns = (data.columns as Record<string, unknown>[]) ?? [];
    const firstColCache = rawColumns[0]?.cachedContents as Record<string, unknown> | undefined;
    const rowsUpdatedAt = data.rowsUpdatedAt as number | undefined;

    return {
      name: (data.name as string) ?? '',
      description: (data.description as string) ?? '',
      rowCount: Number(firstColCache?.count) || 0,
      updatedAt: rowsUpdatedAt ? new Date(rowsUpdatedAt * 1000).toISOString() : '',
      columns,
    };
  }

  /**
   * Execute a SoQL query against a CDC dataset.
   */
  async query(options: QueryOptions, signal?: AbortSignal): Promise<QueryResult> {
    this.validateDatasetId(options.datasetId);
    const config = getServerConfig();
    const params = new URLSearchParams();

    if (options.search) params.set('$q', options.search);
    if (options.select) params.set('$select', options.select);
    if (options.where) params.set('$where', options.where);
    if (options.group) params.set('$group', options.group);
    if (options.having) params.set('$having', options.having);
    if (options.order) params.set('$order', options.order);
    params.set('$limit', String(options.limit ?? 1000));
    if (options.offset) params.set('$offset', String(options.offset));

    const queryString = params.toString();
    const url = `${config.baseUrl}/resource/${options.datasetId}.json?${queryString}`;
    const rows = (await this.fetchJson(url, signal)) as unknown as Record<string, string>[];

    return {
      rows,
      rowCount: rows.length,
      query: decodeURIComponent(queryString),
    };
  }

  private validateDatasetId(datasetId: string): void {
    if (!DATASET_ID_PATTERN.test(datasetId)) {
      throw new Error(
        `Invalid dataset ID "${datasetId}" — must match format [a-z0-9]{4}-[a-z0-9]{4} (e.g., "bi63-dtpu"). Get valid IDs from cdc_discover_datasets.`,
      );
    }
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.throttle();
    const config = getServerConfig();

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.appToken) headers['X-App-Token'] = config.appToken;

    const response = await globalThis.fetch(url, {
      headers,
      signal: signal ?? null,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new Error(
          'Dataset not found (404). Verify the dataset ID exists — it may have been retired or replaced. Search again with cdc_discover_datasets.',
        );
      }
      if (response.status === 429) {
        throw new Error(
          'Rate limited by Socrata API (429). Retry after a brief delay. Consider setting CDC_APP_TOKEN for higher limits.',
        );
      }
      throw new Error(`Socrata API error ${response.status}: ${body.slice(0, 500)}`);
    }

    return (await response.json()) as Record<string, unknown>;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

let _service: SocrataService | undefined;

export function initSocrataService(): void {
  _service = new SocrataService();
}

export function getSocrataService(): SocrataService {
  if (!_service)
    throw new Error('SocrataService not initialized — call initSocrataService() in setup()');
  return _service;
}
