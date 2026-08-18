/**
 * @fileoverview Socrata API response types for the CDC Open Data portal.
 * @module services/socrata/types
 */

/**
 * Allowlisted CDC Socrata hosts. Both front the same Socrata tenant: one catalog, labelled
 * `data.cdc.gov`, whose assets resolve by four-by-four ID on either host. The discovery,
 * metadata, and query paths can therefore target either, and both speak SODA 2.1 and accept
 * the same app token. Restricting to this set keeps host selection from becoming an
 * arbitrary-URL (SSRF) surface.
 */
export const CDC_SOCRATA_DOMAINS = ['data.cdc.gov', 'chronicdata.cdc.gov'] as const;

/** A CDC Socrata host the service may address. */
export type SocrataDomain = (typeof CDC_SOCRATA_DOMAINS)[number];

/**
 * Dataset metadata from the Discovery/Catalog API. Optional fields reflect upstream sparsity.
 *
 * `assetType` is the catalog's own `resource.type`. It is descriptive, not a queryability
 * test: `filter` assets carry real columns and return rows from `/resource/{id}.json`,
 * while `chart` and `map` assets report `viewType: "tabular"` yet have no columns at all.
 * The reliable signal is an empty `columnNames`.
 */
export interface CatalogDataset {
  assetType?: string;
  category?: string;
  columnNames?: string[];
  columnTypes?: string[];
  description?: string;
  id: string;
  name: string;
  pageViews?: number;
  tags?: string[];
  updatedAt?: string;
}

/** Column schema from the Metadata API. */
export interface DatasetColumn {
  dataType: string;
  description?: string;
  fieldName: string;
}

/** Full dataset metadata from the Metadata API. Optional fields reflect upstream sparsity. */
export interface DatasetMetadata {
  columns: DatasetColumn[];
  description?: string;
  name: string;
  rowCount?: number;
  updatedAt?: string;
}

/** Result from catalog discovery. */
export interface DiscoverResult {
  datasets: CatalogDataset[];
  totalCount: number;
}

/** Result from a SoQL query. */
export interface QueryResult {
  /**
   * True when at least one row exists past the ones returned. Established by asking SODA
   * for one row more than the caller's limit and discarding it — the data endpoint reports
   * no total, so an over-fetch is the only way to tell a full last page from a cut one.
   */
  hasMore: boolean;
  /**
   * The SoQL parameters as `$clause=value` pairs, values in the caller's own text rather
   * than URL-encoded, so each clause can be copied back into the parameter it came from.
   * `$limit` is the caller's own, never the internal over-fetch probe.
   */
  query: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}
