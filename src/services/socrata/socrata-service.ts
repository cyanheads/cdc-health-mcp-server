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
    params.set('offset', String(options.offset ?? 0));

    const url = `${config.catalogUrl}?${params}`;
    const data = await this.fetchJson(url, signal);

    const results = (data.results ?? []) as Record<string, unknown>[];
    const datasets: CatalogDataset[] = results.map((r) => {
      const resource = r.resource as Record<string, unknown>;
      const classification = r.classification as Record<string, unknown> | undefined;
      const description = resource.description as string | undefined;
      const category = classification?.domain_category as string | undefined;
      const tags = classification?.domain_tags as string[] | undefined;
      const columnNames = resource.columns_field_name as string[] | undefined;
      const columnTypes = resource.columns_datatype as string[] | undefined;
      const updatedAt = resource.data_updated_at as string | undefined;
      const pageViews = (resource.page_views as Record<string, number> | undefined)
        ?.page_views_total;
      return {
        id: resource.id as string,
        name: resource.name as string,
        ...(description ? { description } : {}),
        ...(category ? { category } : {}),
        ...(tags ? { tags } : {}),
        ...(columnNames ? { columnNames } : {}),
        ...(columnTypes ? { columnTypes } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(typeof pageViews === 'number' ? { pageViews } : {}),
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

    const rawColumns = (data.columns as Record<string, unknown>[]) ?? [];
    const columns: DatasetColumn[] = rawColumns.map((col) => {
      const description = col.description as string | undefined;
      return {
        fieldName: (col.fieldName as string) ?? '',
        dataType: (col.dataTypeName as string) ?? '',
        ...(description ? { description } : {}),
      };
    });

    const firstColCache = rawColumns[0]?.cachedContents as Record<string, unknown> | undefined;
    const rawCount = firstColCache?.count;
    const parsedCount = rawCount != null ? Number(rawCount) : Number.NaN;
    const rowCount = Number.isFinite(parsedCount) ? parsedCount : undefined;
    const rowsUpdatedAt = data.rowsUpdatedAt as number | undefined;
    const updatedAt =
      typeof rowsUpdatedAt === 'number' ? new Date(rowsUpdatedAt * 1000).toISOString() : undefined;
    const description = data.description as string | undefined;

    return {
      name: (data.name as string) ?? '',
      columns,
      ...(description ? { description } : {}),
      ...(typeof rowCount === 'number' ? { rowCount } : {}),
      ...(updatedAt ? { updatedAt } : {}),
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
    params.set('$offset', String(options.offset ?? 0));

    const queryString = params.toString();
    const url = `${config.baseUrl}/resource/${options.datasetId}.json?${queryString}`;
    const rows = await this.fetchJson<Record<string, unknown>[]>(url, signal);

    return {
      rows,
      rowCount: rows.length,
      query: decodeURIComponent(queryString),
    };
  }

  private formatBadRequestError(body: string): string {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const code = parsed.errorCode as string | undefined;
      const data = parsed.data as Record<string, unknown> | undefined;

      if (code === 'query.soql.no-such-column') {
        const col = data?.column ?? 'unknown';
        return `No such column "${col}". Use cdc_get_dataset_schema to see available columns for this dataset.`;
      }
      if (code === 'query.soql.type-mismatch') {
        return `SoQL type mismatch: ${(parsed.message as string)?.split(';')[1]?.trim() ?? 'check column types'}. Use cdc_get_dataset_schema to verify column data types.`;
      }

      const msg = parsed.message ?? parsed.error;
      if (typeof msg === 'string') return `Socrata query error: ${msg.slice(0, 300)}`;
    } catch {
      // Body wasn't JSON — fall through
    }
    return `Socrata API error 400: ${body.slice(0, 300)}`;
  }

  private validateDatasetId(datasetId: string): void {
    if (!DATASET_ID_PATTERN.test(datasetId)) {
      throw new Error(
        `Invalid dataset ID "${datasetId}" — must match format [a-z0-9]{4}-[a-z0-9]{4} (e.g., "bi63-dtpu"). Get valid IDs from cdc_discover_datasets.`,
      );
    }
  }

  private async fetchJson<T = Record<string, unknown>>(
    url: string,
    signal?: AbortSignal,
  ): Promise<T> {
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
      if (response.status === 400) {
        throw new Error(this.formatBadRequestError(body));
      }
      throw new Error(`Socrata API error ${response.status}: ${body.slice(0, 500)}`);
    }

    return (await response.json()) as T;
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
