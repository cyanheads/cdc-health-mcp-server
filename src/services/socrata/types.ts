/**
 * @fileoverview Socrata API response types for the CDC Open Data portal.
 * @module services/socrata/types
 */

/** Dataset metadata from the Discovery/Catalog API. */
export interface CatalogDataset {
  category: string;
  columnNames: string[];
  columnTypes: string[];
  description: string;
  id: string;
  name: string;
  pageViews: number;
  tags: string[];
  updatedAt: string;
}

/** Column schema from the Metadata API. */
export interface DatasetColumn {
  dataType: string;
  description: string;
  fieldName: string;
}

/** Full dataset metadata from the Metadata API. */
export interface DatasetMetadata {
  columns: DatasetColumn[];
  description: string;
  name: string;
  rowCount: number;
  updatedAt: string;
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
  rows: Record<string, string>[];
}
