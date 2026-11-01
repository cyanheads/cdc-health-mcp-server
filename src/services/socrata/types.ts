/**
 * @fileoverview Socrata API response types for the CDC Open Data portal, and the bounds the
 * service and the definitions that call it both name.
 * @module services/socrata/types
 */

/**
 * Deadline on one Socrata request, headers and body together, counted from when the request is
 * sent. The deepest tool calls chain two requests one after the other — a data query and then
 * its offset-0 probe or metadata check, a catalog search and then its vocabulary lookup — so
 * two deadlines and the spacing between them settle inside the 60-second default request
 * timeout of MCP SDK clients.
 */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The request deadline as the error contracts that name it phrase it. */
export const REQUEST_TIMEOUT_TEXT = `${REQUEST_TIMEOUT_MS / 1000} seconds`;

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
 * The asset types the CDC catalog holds, spelled as `resource.type` reports them. The
 * Discovery API's `only` filter takes other spellings of these and answers an unrecognized
 * value with an empty page rather than an error, so only this set may reach it.
 */
export const CATALOG_ASSET_TYPES = [
  'dataset',
  'filter',
  'chart',
  'map',
  'story',
  'file',
  'href',
] as const;

/** One catalog asset type. */
export type CatalogAssetType = (typeof CATALOG_ASSET_TYPES)[number];

/** One publisher-labelled URL from a catalog entry's `metadata.access_points`. */
export interface AccessPoint {
  /** The publisher's own label, free text (`html`, `map-server`, `SAS zip`). */
  label: string;
  url: string;
}

/**
 * Dataset metadata from the Discovery/Catalog API. Optional fields reflect upstream sparsity.
 *
 * `assetType` is the catalog's own `resource.type`. It is descriptive, not a queryability
 * test: `filter` assets carry real columns and return rows from `/resource/{id}.json`,
 * while `chart` and `map` assets report `viewType: "tabular"` yet have no columns at all.
 * The reliable signal is an empty `columnNames`.
 */
export interface CatalogDataset {
  /** Present on `href` entries, where it is the only place their external URL appears. */
  accessPoints?: AccessPoint[];
  assetType?: string;
  category?: string;
  columnNames?: string[];
  columnTypes?: string[];
  description?: string;
  id: string;
  name: string;
  pageViews?: number;
  /** The datasets a chart, map, filter, or story is built on, from `resource.parent_fxf`. */
  parentIds?: string[];
  /** The entry's portal page: `https://data.cdc.gov/d/{id}`, or `/stories/s/{id}` for a story. */
  permalink?: string;
  tags?: string[];
  updatedAt?: string;
}

/** Column schema from the Metadata API. */
export interface DatasetColumn {
  dataType: string;
  description?: string;
  fieldName: string;
}

/**
 * Where a `rowCount` came from. `live` is a `count(*)` run against the dataset for this
 * call; `cached` is `cachedContents.count` off the metadata document, which Socrata builds
 * once and does not refresh as rows land — on an actively-updated dataset it understates the
 * real total badly, and it is the only figure available when the count request fails.
 */
export type RowCountSource = 'cached' | 'live';

/**
 * Full dataset metadata from the Metadata API. Optional fields reflect upstream sparsity.
 *
 * `attribution`, `citation`, `geographicCoverage`, `license`, `temporalCoverage`, and
 * `updateFrequency` are publisher-written text from the metadata document, relayed with
 * surrounding whitespace trimmed and never parsed: a value may be an ISO 8601 interval or
 * duration (`2015-01-01/2026-05-31`, `R/P1M`) or words (`2019/present`, `irregular`). Absent
 * when the publisher recorded none, or only whitespace.
 */
export interface DatasetMetadata {
  /** The document's `attribution` — the publishing office. */
  attribution?: string;
  /** `custom_fields["Data Quality"]["Suggested Citation"]`. */
  citation?: string;
  columns: DatasetColumn[];
  /** Plain text: markup stripped and entity references decoded once (`utils/text`). */
  description?: string;
  /** `custom_fields["Common Core"]["Geographic Coverage"]`. */
  geographicCoverage?: string;
  /** The document's `license.name`. */
  license?: string;
  name: string;
  /**
   * The dataset this asset is a view of, from the document's `modifyingViewUid`: set on every
   * chart, map, and filter, absent on a dataset in its own right and on a story, file, or link.
   */
  parentId?: string;
  rowCount?: number;
  /** Present exactly when `rowCount` is. */
  rowCountSource?: RowCountSource;
  /** `custom_fields["Common Core"]["Temporal Applicability"]` — the period the data covers. */
  temporalCoverage?: string;
  updatedAt?: string;
  /** `custom_fields["Common Core"]["Update Frequency"]` — the publishing cadence. */
  updateFrequency?: string;
}

/**
 * One value of a catalog-controlled vocabulary — a domain category or a domain tag — with
 * the number of catalog entries carrying it. The Discovery API publishes both vocabularies
 * per domain, and `cdc_discover_datasets`'s `category` and `tags` filters are matched
 * against exactly these values, so a value absent here matches nothing upstream.
 */
export interface VocabularyTerm {
  /** Catalog entries carrying this value, as the Discovery API counts them. */
  datasetCount: number;
  /** The value as the catalog spells it — the form the discovery filters expect. */
  value: string;
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
