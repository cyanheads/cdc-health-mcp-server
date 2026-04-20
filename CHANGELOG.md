# Changelog

## [0.5.0] - 2026-04-19

Framework upgrade to `@cyanheads/mcp-ts-core` 0.4.1, honest handling of sparse upstream data, and skill sync.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` bumped `^0.2.12` → `^0.4.1`
- **Service normalization**: `SocrataService.discover()` and `getMetadata()` now use conditional spreads instead of fabricating empty strings, zeros, or empty arrays for missing upstream fields — preserves the distinction between "unknown" and "empty"
- **Tool output schemas**: `cdc_discover_datasets` and `cdc_get_dataset_schema` mark sparse fields as `.optional()` (category, tags, columnNames, columnTypes, pageViews, description, rowCount, updatedAt) to reflect real Socrata catalog sparsity
- **Format honesty**: `format()` functions render `—` for absent fields and skip lines entirely when description/tags/columns are missing, rather than showing fake `0` or `''` values
- **Domain types**: `CatalogDataset`, `DatasetColumn`, and `DatasetMetadata` in `services/socrata/types.ts` mark sparse fields as optional
- `cdc_query_dataset` description rewritten as a single cohesive paragraph (per framework 0.4 guidance); SoQL enumeration tip moved into the `select` parameter's `.describe()`
- Dev dependencies bumped: `@biomejs/biome` ^2.4.10→^2.4.12, `@types/node` ^25.5.2→^25.6.0, `@vitest/coverage-istanbul` ^4.1.2→^4.1.4, `typescript` ^6.0.2→^6.0.3, `vitest` ^4.1.2→^4.1.4

### Added

- `skills/add-app-tool/` — new skill from framework 0.4.1 covering MCP Apps tool + paired UI resource scaffolding

### Fixed

- Security vulnerabilities in transitive dependencies (`hono`, `@hono/node-server`, `vite`) resolved by refreshing `bun.lock` — `bun audit` now clean (was 10 advisories, 2 high)

### Synced

- 14 project skills updated from framework 0.4.1: `add-prompt`, `add-resource`, `add-service`, `add-test`, `add-tool`, `api-testing`, `api-workers`, `design-mcp-server`, `devcheck`, `field-test`, `maintenance`, `migrate-mcp-ts-template`, `polish-docs-meta`, `setup`

## [0.4.3] - 2026-04-04

Richer discovery output, simplified tool handlers, and service cleanup.

### Changed

- `cdc_discover_datasets` format output now shows page view counts, column types alongside column names, and filter criteria echo in the results header
- Tool handlers for `cdc_discover_datasets` and `cdc_query_dataset` pass input directly to service methods instead of destructuring
- Removed duplicate column array parsing in `SocrataService.getMetadata`

### Fixed

- `datasets.resource.ts` JSDoc corrected to match actual behavior (top 50 by popularity, not categories with counts)

## [0.4.2] - 2026-04-04

Added public hosted instance, updated dev dependencies.

### Added

- Public hosted server at `https://cdc.caseyjhand.com/mcp` — documented in README banner and getting started section
- `remotes` field in server.json pointing to the public Streamable HTTP endpoint

### Changed

- Dev dependencies bumped: `@biomejs/biome` ^2.4.7→^2.4.10, `@types/node` ^25.5.0→^25.5.2, `typescript` ^5.9.3→^6.0.2, `vitest` ^4.1.0→^4.1.2

## [0.4.1] - 2026-04-03

Support non-string Socrata column values (GeoJSON, numbers) in query results.

### Fixed

- `cdc_query_dataset` output schema changed from `z.string()` to `z.unknown()` for row field values — geo columns return GeoJSON objects, not strings
- Format function now handles non-string row values: objects are JSON-stringified, nulls render as empty, newlines are collapsed to spaces
- `QueryResult.rows` type broadened from `Record<string, string>[]` to `Record<string, unknown>[]` in types and service
- Offset parameter now always included in catalog and data query requests (was omitted when `0`, causing unexpected API behavior)

## [0.4.0] - 2026-04-03

README rewrite, Dockerfile cleanup, binary rename, and project metadata improvements.

### Changed

- README rewritten with expanded tool documentation, Docker and Streamable HTTP configuration examples, project structure overview, and development guide
- Dockerfile image title and log directory renamed from `cdc-health-statistics-mcp-server` to `cdc-health-mcp-server`
- Binary entry point renamed from `cdc-health-statistics-mcp-server` to `cdc-health-mcp-server` in package.json

### Added

- Author details, funding links (GitHub Sponsors, Buy Me a Coffee), and Bun engine requirement (`>=1.3.2`) in package.json
- `@vitest/coverage-istanbul` dev dependency for test coverage reporting
- `@vitest/coverage-istanbul` added to devcheck dependency ignore list

## [0.3.0] - 2026-04-03

Packaging overhaul, npm scope rename, and project metadata hardening.

### Changed

- **npm package renamed** from `cdc-health-statistics-mcp-server` to `@cyanheads/cdc-health-mcp-server`
- Server identity updated to `io.github.cyanheads/cdc-health-mcp-server` in server.json
- Added `mcpName` field to package.json for MCP registry identification
- Dockerfile now includes OCI image description and source URL labels
- `.env.example` updated with CDC-specific environment variables
- CLAUDE.md agent protocol updated with CDC-specific code patterns, naming examples, and config reference

### Added

- `LICENSE` file (Apache 2.0)
- `bunfig.toml` for Bun runtime configuration
- `docs/tree.md` directory structure documentation
- `CDC_APP_TOKEN` environment variable in server.json package definitions
- `CDC_CATALOG_URL` documented in CLAUDE.md server config table
- `author`, `homepage`, `bugs`, `packageManager` fields in package.json

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
