# Changelog

## [0.2.0] - 2026-04-03

Diagnostics echo, structured Socrata error messages, and discovery refinements.

### Added

- `appliedFilters` field in `cdc_discover_datasets` output — echoes query, category, and tag filters for diagnostics
- Structured 400 error handling in Socrata service — surfaces column-not-found and type-mismatch errors with guidance to check schema
- Offset cap (max 9999) on `cdc_discover_datasets` to prevent runaway pagination

### Changed

- `cdc://datasets` resource description clarified as top 50 by popularity with pointer to `cdc_discover_datasets` for full catalog search
- Empty-results message in `cdc_discover_datasets` now includes the applied filter criteria

## [0.1.1] - 2026-04-03

Field-test-driven fixes for data accuracy, discovery relevance, and developer guidance.

### Fixed

- `rowCount` now reads from column `cachedContents.count` instead of missing `rowCount` field
- `updatedAt` now derives from `rowsUpdatedAt` epoch timestamp instead of missing `dataUpdatedAt`
- Query result `query` string is now URL-decoded for readability

### Changed

- Discovery API requests include `search_context=data.cdc.gov` for more relevant results
- Removed overly strict validation requiring at least one of `search`/`where`/`select` in `cdc_query_dataset` — bare dataset queries are now allowed
- Empty-results messages for discover and query tools now include actionable troubleshooting suggestions

### Added

- `list()` on `cdc://datasets` and `cdc://datasets/{datasetId}` resources for MCP resource discovery

## [0.1.0] - 2026-04-03

Initial release. MCP server for discovering and querying CDC public health datasets via the Socrata SODA API.

### Added

- **Tools**
  - `cdc_discover_datasets` — search the CDC dataset catalog by keyword, category, or tag
  - `cdc_get_dataset_schema` — fetch column schema, row count, and metadata for a dataset
  - `cdc_query_dataset` — execute SoQL queries with filtering, aggregation, sorting, and full-text search
- **Resources**
  - `cdc://datasets` — paginated dataset catalog listing for orientation
  - `cdc://datasets/{datasetId}` — individual dataset metadata and column schema
- **Prompts**
  - `analyze_health_trend` — guided workflow for investigating public health questions (discover, inspect, query, compare, synthesize)
- **Services**
  - Socrata SODA API client with rate-limit-aware request throttling (250ms minimum interval)
  - Configurable base URL, catalog URL, and optional app token via environment variables
- **Configuration**
  - `CDC_APP_TOKEN` — optional Socrata app token for higher rate limits
  - `CDC_BASE_URL` — configurable SODA API base URL (default: `https://data.cdc.gov`)
  - `CDC_CATALOG_URL` — configurable Discovery API URL (default: `https://api.us.socrata.com/api/catalog/v1`)
- **Tests**
  - Unit tests for server config, discover tool, query tool, datasets resource, and health trend prompt
