/**
 * @fileoverview Socrata SODA API client for CDC Open Data portal.
 * Handles discovery, metadata, and SoQL queries with rate-limit-aware request spacing.
 * @module services/socrata/socrata-service
 */

import {
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  CatalogDataset,
  DatasetColumn,
  DatasetMetadata,
  DiscoverResult,
  QueryResult,
  SocrataDomain,
} from './types.js';

const MIN_REQUEST_INTERVAL_MS = 250;

/** Options for discovering datasets. */
export interface DiscoverOptions {
  category?: string | undefined;
  domain?: SocrataDomain | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  query?: string | undefined;
  tags?: string[] | undefined;
}

/** Options for querying a dataset via SoQL. */
export interface QueryOptions {
  datasetId: string;
  domain?: SocrataDomain | undefined;
  group?: string | undefined;
  having?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  order?: string | undefined;
  search?: string | undefined;
  select?: string | undefined;
  where?: string | undefined;
}

/**
 * Strip the trailing Scala `; position: Map(...)` debug dump that Socrata appends
 * to SoQL error messages — noise for an agent acting on the error.
 */
function stripPositionTail(message: string): string {
  return message.replace(/;\s*position:\s*Map\([\s\S]*$/, '').trimEnd();
}

export class SocrataService {
  private lastRequestTime = 0;

  /**
   * Resolve the SODA base URL for a request. An explicit allowlisted `domain` selects the
   * host; otherwise the configured `CDC_BASE_URL` (default `https://data.cdc.gov`) applies,
   * so env-based overrides keep working for callers that don't pass a domain.
   */
  private baseUrlFor(domain: SocrataDomain | undefined): string {
    return domain ? `https://${domain}` : getServerConfig().baseUrl;
  }

  /**
   * Search the CDC dataset catalog by keyword, category, or tag.
   */
  async discover(options: DiscoverOptions, signal?: AbortSignal): Promise<DiscoverResult> {
    const config = getServerConfig();
    const domain = options.domain ?? 'data.cdc.gov';
    const params = new URLSearchParams({
      domains: domain,
      search_context: domain,
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
   *
   * @param domain - Allowlisted CDC Socrata host. Omit to use the configured default host.
   */
  async getMetadata(
    datasetId: string,
    signal?: AbortSignal,
    domain?: SocrataDomain,
  ): Promise<DatasetMetadata> {
    const url = `${this.baseUrlFor(domain)}/api/views/${datasetId}.json`;
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
    const rowCount = rawCount != null ? Number(rawCount) : Number.NaN;
    const rowsUpdatedAt = data.rowsUpdatedAt as number | undefined;
    const updatedAt =
      typeof rowsUpdatedAt === 'number' ? new Date(rowsUpdatedAt * 1000).toISOString() : undefined;
    const description = data.description as string | undefined;

    return {
      name: (data.name as string) ?? '',
      columns,
      ...(description ? { description } : {}),
      ...(Number.isFinite(rowCount) ? { rowCount } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  /**
   * Execute a SoQL query against a CDC dataset.
   */
  async query(options: QueryOptions, signal?: AbortSignal): Promise<QueryResult> {
    const params = new URLSearchParams();

    if (options.search) params.set('$q', options.search);
    if (options.select) params.set('$select', options.select);
    if (options.where) params.set('$where', options.where);
    if (options.group) params.set('$group', options.group);
    if (options.having) params.set('$having', options.having);
    if (options.order) params.set('$order', options.order);
    params.set('$limit', String(options.limit ?? 100));
    params.set('$offset', String(options.offset ?? 0));

    const queryString = params.toString();
    const url = `${this.baseUrlFor(options.domain)}/resource/${options.datasetId}.json?${queryString}`;
    const rows = await this.fetchJson<Record<string, unknown>[]>(url, signal);

    return {
      rows,
      rowCount: rows.length,
      query: decodeURIComponent(queryString),
    };
  }

  private throwBadRequest(body: string, url: string): never {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // Body wasn't JSON — fall through to generic.
    }

    // Socrata names the error code `errorCode` for query.soql.* (semantic) errors
    // but `code` for query.compiler.* (parse) errors — check both.
    const code = (parsed?.errorCode ?? parsed?.code) as string | undefined;
    const data = parsed?.data as Record<string, unknown> | undefined;
    const rawMessage = (parsed?.message ?? parsed?.error) as string | undefined;

    if (code === 'query.soql.no-such-column') {
      const col = data?.column ?? 'unknown';
      throw validationError(
        `No such column "${col}". Use cdc_get_dataset_schema to see available columns for this dataset.`,
        { reason: 'no_such_column', column: col, url },
      );
    }
    if (code === 'query.soql.type-mismatch') {
      const detail = rawMessage?.split(';')[1]?.trim() ?? 'check column types';
      throw validationError(
        `SoQL type mismatch: ${detail}. Use cdc_get_dataset_schema to verify column data types.`,
        { reason: 'type_mismatch', url },
      );
    }
    if (code === 'query.soql.column-not-in-group-bys') {
      const col = data?.column ?? 'unknown';
      throw validationError(
        `Column "${col}" must appear in GROUP BY or be wrapped in an aggregate (e.g. sum()). Add group="${col}" or aggregate it in select.`,
        { reason: 'invalid_query', column: col, url },
      );
    }
    if (
      code === 'query.compiler.malformed' &&
      rawMessage &&
      /Expected an expression, but got/i.test(rawMessage)
    ) {
      throw validationError(
        `SoQL parse error: ${stripPositionTail(rawMessage).slice(0, 200)}. If a column name matches a SoQL keyword (group, select, where, order, limit, offset, having, search), wrap it in backticks — e.g. \`group\`='By Year'.`,
        { reason: 'invalid_query', url },
      );
    }

    if (typeof rawMessage === 'string') {
      throw validationError(`Socrata query error: ${stripPositionTail(rawMessage).slice(0, 300)}`, {
        reason: 'invalid_query',
        url,
      });
    }

    throw validationError(`Socrata API error 400: ${body.slice(0, 300)}`, {
      reason: 'invalid_query',
      url,
    });
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
        throw notFound(
          'Dataset not found (404). Verify the dataset ID exists — it may have been retired or replaced. Search again with cdc_discover_datasets.',
          { reason: 'dataset_not_found', url },
        );
      }
      if (response.status === 429) {
        throw rateLimited(
          'Rate limited by Socrata API (429). Retry after a brief delay. Consider setting CDC_APP_TOKEN for higher limits.',
          { reason: 'rate_limited', url },
        );
      }
      if (response.status === 400) {
        this.throwBadRequest(body, url);
      }
      throw await httpErrorFromResponse(response, {
        service: 'Socrata',
        captureBody: false,
        data: { reason: 'upstream_error', url, body: body.slice(0, 500) },
      });
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
    throw serviceUnavailable(
      'SocrataService not initialized — call initSocrataService() in setup()',
    );
  return _service;
}
