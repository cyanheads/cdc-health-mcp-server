/**
 * @fileoverview Socrata API response types for the CDC Open Data portal.
 * @module services/socrata/types
 */

/**
 * Allowlisted CDC Socrata hosts. The discovery, metadata, and query paths can target
 * either portal; both speak SODA 2.1 and accept the same app token. Restricting to this
 * set keeps host selection from becoming an arbitrary-URL (SSRF) surface.
 */
export const CDC_SOCRATA_DOMAINS = ['data.cdc.gov', 'chronicdata.cdc.gov'] as const;

/** A CDC Socrata host the service may address. */
export type SocrataDomain = (typeof CDC_SOCRATA_DOMAINS)[number];

/** Dataset metadata from the Discovery/Catalog API. Optional fields reflect upstream sparsity. */
export interface CatalogDataset {
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
  query: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}
