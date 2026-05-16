# Changelog

## [0.6.4] - 2026-05-16

Framework refresh to `@cyanheads/mcp-ts-core` 0.9.1. Adopts the new server-level `instructions` field and `httpErrorFromResponse` utility, gains the portability lint rules from 0.9.x at build time, and syncs project skills from upstream. No tool/resource/prompt API changes.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` `^0.8.19` → `^0.9.1`. 0.9.0 introduced the `instructions` field on `createApp` / `createWorkerHandler` (server-level model orientation surfaced on every `initialize`), the `mcp_tool_scopes` JWT-claim union and `MCP_AUTH_DISABLE_SCOPE_CHECKS` bypass flag for OIDC providers that can't override the standard `scope` claim, and five new schema-portability lint rules (`schema-format-portability`, `schema-anyof-needs-type`, `schema-no-discriminator-keyword`, `schema-no-defs`, `schema-dialect-tag`). 0.9.1 carried follow-up linter and skill polish.
- **`SocrataService.fetchJson`** — generic upstream error path now delegates to `httpErrorFromResponse` from `@cyanheads/mcp-ts-core/utils`. Replaces the previous hand-rolled `serviceUnavailable` throw with status-aware classification: 500/501 → `InternalError`, 502/503 → `ServiceUnavailable`, 504 → `Timeout`. The dedicated 400/404/429 branches above it are unchanged.
- **Dev dependencies**: `@biomejs/biome` `^2.4.14` → `^2.4.15`, `@vitest/coverage-istanbul` and `vitest` `^4.1.5` → `^4.1.6`, `@types/node` `^25.6.2` → `^25.8.0`.
- **`scripts/devcheck.ts`** — `bun outdated` parser updated for the new markdown-table output. Bun started emitting leading `|` (shifting the package cell from index 0 to 1) and appending a `(dev|peer|prod|optional)` workspace marker to the package name; the allowlist now strips the marker before lookup.
- **`scripts/build-changelog.ts`** — `SUMMARY_MAX_LENGTH` `250` → `350` (synced from framework template; gives a little more room for one-line release headlines).
- **README** — `OTEL_ENABLED` env-var row now links to the framework's telemetry docs and notes what gets instrumented (spans, metrics, completion logs).

### Added

- **Server-level `instructions`** in `src/index.ts` — concise orientation forwarded on every `initialize`: domain summary, four-by-four ID format, discover → inspect → query workflow, and the SODA string-typed-values gotcha. Clients that surface `instructions` to the model get session-level grounding without the text bloating individual tool descriptions.

### Synced

- **9 project skills refreshed from framework 0.9.x**: `add-tool` 2.8 → 2.9 (mutator response design), `api-auth` 1.0 → 1.1 (`mcp_tool_scopes` claim union, `MCP_AUTH_DISABLE_SCOPE_CHECKS` bypass), `api-config` 1.3 → 1.4 (new bypass env var), `api-errors` 1.5 → 1.6 ("When not to throw" section), `api-linter` 1.2 → 1.3 (portability rules), `api-workers` 1.3 → 1.4 (`instructions` resolver), `design-mcp-server` 2.10 → 2.11 (server-reports / agent-decides split), `field-test` 2.3 → 2.4 (mutator observability test category), `polish-docs-meta` 1.7 → 1.8 (350-char summary limit), `security-pass` 1.3 → 1.4 (scope-bypass audit), `tool-defs-analysis` 1.0 → 1.2 (mutator observability + unit-bearing numeric names — 10 → 12 categories).
- **`.claude/skills/`** mirror resynced to match `skills/`.

## [0.6.3] - 2026-05-08

Definition-language polish across every tool, resource, and prompt — driven by a `tool-defs-analysis` audit. Tightens query defaults, removes display truncation that hid data from the LLM, fills in a missing error contract on `cdc://datasets`, and drops a duplicate dataset-ID validation that the Zod schema already enforces at the edge.

### Changed

- **`cdc_query_dataset` default limit** `1000` → `100` (max unchanged at 5000). The previous 1000-row default frequently sent multi-MB payloads to the LLM for exploratory queries; 100 is enough for orientation, and callers who need more set `limit` explicitly. Schema description and assembled query string updated to match.
- **`cdc_query_dataset.format` no longer truncates display at 50 rows** — the markdown table now renders every row in `result.rows`. Volume is already bounded by the schema-enforced `limit` (default 100, max 5000), so the 50-row clamp was actively hiding data the caller had explicitly requested.
- **`cdc_discover_datasets.format` no longer truncates dataset descriptions at 300 chars** — full description text is rendered. Dataset descriptions are typically a paragraph or two; the clamp was lossy without meaningfully bounding output size.
- **Recovery messages on `rate_limited` simplified** across all four definitions (`cdc_discover_datasets`, `cdc_get_dataset_schema`, `cdc_query_dataset`, `cdc://datasets/{datasetId}`): `"Wait briefly and retry, or set CDC_APP_TOKEN for higher rate limits."` → `"Retry after a brief delay; the request was rate-limited."`. The `CDC_APP_TOKEN` hint was deployment-time guidance, not request-time recovery — clients reading recovery hints can't act on it. Token-setup guidance lives in README/CLAUDE.md.
- **Tool descriptions de-jargoned** — removed SoQL-internal references like "(maps to `$q`)" and "for debugging" from user-facing descriptions; replaced ambient framing ("Use this first to find...", "Essential before writing SoQL queries...") with concrete pointers ("Get dataset IDs from `cdc_discover_datasets`."). Output `name` field describes gain a concrete example (`'Provisional COVID-19 Deaths by Sex and Age'`) so the LLM knows the catalog's display-name style.
- **`cdc_query_dataset.output.query` describe** — `"Assembled SoQL query string (for debugging)."` → `"Assembled SoQL query string sent to Socrata."`. The string is the actual upstream request, not a debug artifact.
- **`cdc://datasets/{datasetId}` description** — collapsed `"Equivalent to cdc_get_dataset_schema — useful for injecting dataset context directly."` to `"Same payload as cdc_get_dataset_schema."` (the URI-addressability is the differentiator, already implicit in the resource type).
- **`analyze_health_trend` prompt** — `geography` arg gains a concrete state example (`"California"`); step 3 ("Baseline") explicitly names `cdc_query_dataset` instead of "Query the most relevant dataset".
- **`docs/design.md`** synced to match the new `cdc_query_dataset` defaults and description language.

### Added

- **`cdc://datasets` resource gains a typed `errors[]` contract** — `rate_limited` and `upstream_error` reasons are now declared inline. Previously the resource threw via service-layer factories without surfacing failure modes through `_meta['mcp-ts-core/errors']`. Brings the catalog resource to parity with `cdc://datasets/{datasetId}` and the three tools.

### Removed

- **`SocrataService.validateDatasetId`** — duplicate of the Zod regex (`^[a-z0-9]{4}-[a-z0-9]{4}$`) already enforced on every caller (`cdc_get_dataset_schema.input.datasetId`, `cdc_query_dataset.input.datasetId`, `cdc://datasets/{datasetId}` params). The service-layer check fired only on inputs that couldn't reach it and added a second source of truth for the format. Tests for the service-level check removed; tool/resource Zod parsing covers the contract.

## [0.6.2] - 2026-05-08

Framework refresh to `@cyanheads/mcp-ts-core` 0.8.19 — picks up the HTTP SSE per-request retention leak fix, the `ctx.sessionId` and `ctx.auth.token` surfacing fixes, and the engines bump to Bun ≥1.3.0 / Node ≥24.0.0. No tool/resource/prompt code changes — CDC server doesn't consume the new context fields, but production HTTP deployments benefit from the SSE leak fix immediately.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` `^0.8.15` → `^0.8.19`. Notable changes for this server's runtime:
  - `0.8.16` — HTTP SSE per-request retention leak fix ([cyanheads/mcp-ts-core#50](https://github.com/cyanheads/mcp-ts-core/issues/50)). `closePerRequestInstances` now binds to the request `AbortSignal` so ungraceful client disconnects (the dominant SSE GET case) close the per-request `McpServer` / `McpSessionTransport` pair. The `mcp.http.close_failures` counter gains a `trigger=sse-abort` tag.
  - `0.8.17` — `ctx.sessionId` surfaced on `Context` for HTTP handlers ([cyanheads/mcp-ts-core#116](https://github.com/cyanheads/mcp-ts-core/issues/116)). Defined under stateful / auto session mode; opt-in for stateless via `createApp({ context: { exposeStatelessSessionId: true } })`. Not consumed by this server.
  - `0.8.18` — `ctx.auth.token` no longer dropped by `toAuthContext` ([cyanheads/mcp-ts-core#121](https://github.com/cyanheads/mcp-ts-core/issues/121)). Public `AuthContext` type gains `token?: string`. Not consumed by this server.
  - `0.8.19` — telemetry visualization docs (Grafana dashboard JSON + vendor-agnostic query recipes), the new `api-telemetry` skill, and the engines bump.
- **Engines**: `node` `>=22.0.0` → `>=24.0.0` (mirrors framework 0.8.19 floor; `bun` already at `>=1.3.2`).
- **Docker base image**: `oven/bun:1` → `oven/bun:1.3` for both build and production stages.
- **Dev dependency**: `@types/node` `^25.6.0` → `^25.6.2`.

### Added

- **`skills/api-telemetry/`** (v1.0) — new framework skill catalog covering every span name, metric name + attributes, completion-log field, env var, runtime caveat, and cardinality rule the framework emits. Cross-linked from `CLAUDE.md` skill index.

### Synced

- **6 project skills refreshed from framework 0.8.17 / 0.8.19**: `api-context` 1.2 → 1.3 (new `ctx.sessionId` section), `api-utils` 2.1 → 2.2 (telemetry section header points to the new `api-telemetry` skill), `maintenance` 2.0 → 2.1 (Phase C now resyncs pristine reference files on content-hash mismatch), `report-issue-framework` 1.5 → 1.6 and `report-issue-local` 1.4 → 1.5 (terser issue-writing guidance, Bun `1.3.x` examples), `setup` 1.6 → 1.7 (`bunx` examples, substituted-name verification, adds `release-and-publish` to the rough progression).
- **`scripts/build-changelog.ts`** synced from framework 0.8.19 (parses and validates the new `security: boolean` frontmatter field).
- **`.claude/skills/`** mirror resynced to match `skills/`.

## [0.6.1] - 2026-05-05

Framework upgrade to `@cyanheads/mcp-ts-core` 0.8.15 and adoption of the new typed error contracts on every tool, resource, and the Socrata service layer.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` bumped `^0.7.0` → `^0.8.15` (spans the 0.8.x line — typed error contracts in 0.8.0, `httpErrorFromResponse` / `partialResult` utilities, three additional error factories, the `spillover()` canvas helper in 0.8.15, and supporting handler-body + conformance lints).
- **Typed error contracts on every tool and resource** — `cdc_discover_datasets`, `cdc_get_dataset_schema`, `cdc_query_dataset`, and the `cdc://datasets/{datasetId}` resource each declare an inline `errors: [{ reason, code, when, recovery, retryable? }]`. Reasons cover `dataset_not_found`, `rate_limited`, `upstream_error`, plus `cdc_query_dataset`-specific `no_such_column` / `type_mismatch` / `invalid_query`. Surfaces in `tools/list` / `resources/list` under `_meta['mcp-ts-core/errors']` so clients see the failure modes and recovery hints upfront.
- **`SocrataService` switches from `throw new Error(...)` to error factories** — `notFound`, `rateLimited`, `serviceUnavailable`, and `validationError` from `@cyanheads/mcp-ts-core/errors`. Every throw site now carries `data: { reason, ... }` matching the tool/resource contracts so the framework's auto-classifier preserves the `reason` discriminator end-to-end (services don't have `ctx.fail`).
- **`SocrataService.formatBadRequestError` → `throwBadRequest`** — was a string-formatter feeding `throw new Error(...)`; now throws `validationError` directly with reason discrimination (`no_such_column`, `type_mismatch`, `invalid_query`) and the originating URL captured in `data`.
- **`SocrataService.validateDatasetId`** — now throws `validationError` with `data: { reason: 'invalid_dataset_id', datasetId }` instead of a plain `Error`.
- **`getMetadata` row-count parsing** — folds the finite-number guard into the conditional spread (`Number.isFinite(rowCount) ? { rowCount } : {}`), removing an intermediate `parsedCount` variable.
- **Agent protocol (`CLAUDE.md`)** — Errors section rewritten to lead with the typed-contract path (`errors[]` + `ctx.fail`); factories demoted to fallback. Skill table gained `add-app-tool`, `tool-defs-analysis`, `migrate-mcp-ts-template`, `api-canvas`. `dev:stdio` / `dev:http` rows removed; Commands table notes `bun run rebuild && bun run start:*` for dev smoke-tests. Checklist updated to flag service-layer `data: { reason }` as part of the error-contract pattern.
- **Removed `dev:stdio` / `dev:http` package scripts** — unused; the rebuild-and-start pattern noted in CLAUDE.md replaces them.
- **Dev dependencies bumped**: `@biomejs/biome` ^2.4.13 → ^2.4.14, `tsc-alias` ^1.8.16 → ^1.8.17.

### Added

- **`scripts/check-framework-antipatterns.ts`** — new devcheck step (`Framework Antipatterns`) that flags SDK-coupling shortcuts the framework can't catch through type-checking alone.
- **`scripts/build-changelog.ts` and `scripts/split-changelog.ts`** — synced from framework 0.8.x for changelog directory tooling (assemble flat `CHANGELOG.md` from `changelog/<minor>.x/<version>.md` entries; split a flat changelog back into the directory layout).
- **`skills/api-canvas/`** — new skill from framework 0.8.x covering the DataCanvas Tier 3 SQL/analytical workspace and the `spillover()` helper for paginated upstream APIs.
- **`skills/tool-defs-analysis/`** — new skill from framework 0.8.x for read-only audits of definition language across the surface (10 categories: voice, leaks, defaults, recovery hints, examples, structure, etc.).

### Synced

- **18 project skills refreshed from framework 0.8.15**: `add-service`, `add-tool`, `api-config`, `api-context`, `api-errors` (typed-contract surface), `api-linter` (handler-body + conformance lint families), `api-workers`, `design-mcp-server`, `field-test`, `maintenance`, `release-and-publish`, `report-issue-framework`, `report-issue-local`, `security-pass`, `setup`, plus the two new skills above.
- **`scripts/devcheck.ts`** — adds the `Framework Antipatterns` check to the pipeline.
- **`.claude/skills/`** mirror resynced to match `skills/`.

## [0.6.0] - 2026-04-24

Framework upgrade to `@cyanheads/mcp-ts-core` 0.7.0, adoption of the new `parseEnvConfig` helper for env-var-aware startup errors, and internal cleanup.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` bumped `^0.4.1` → `^0.7.0` (spans three minor releases — see the framework's per-version changelogs under `node_modules/@cyanheads/mcp-ts-core/changelog/` for details).
- **Server config adopts `parseEnvConfig`** — `src/config/server-config.ts` now uses the new `parseEnvConfig` helper (shipped in framework 0.5.0) so startup errors name the actual env var at fault (`CDC_APP_TOKEN`) instead of the internal Zod path (`appToken`). Existing behavior unchanged when env vars validate.
- **`SocrataService.fetchJson` genericized** — `fetchJson<T = Record<string, unknown>>(url, signal): Promise<T>` removes the `as unknown as Record<string, unknown>[]` double cast at the `query()` call site. Default type preserves existing behavior for `discover()` and `getMetadata()`.
- **`cdc_query_dataset` empty-rows check simplified** — `if (result.rows.length === 0 || !result.rows[0])` → `if (!result.rows[0])` (equivalent TS narrowing, one fewer condition).
- **Tool output schemas: array-element `.describe()`** — `cdc_discover_datasets.output.datasets[]` and `cdc_get_dataset_schema.output.columns[]` now include `.describe()` on the inner `z.object({...})` shape, satisfying the framework 0.6.16 recursive `describe-on-fields` linter rule.
- **Agent protocol (`CLAUDE.md`) skill table updated** — dropped `devcheck` (removed from framework in 0.5.2), added `api-linter`, `security-pass`, `release-and-publish`.
- **Dev dependencies bumped**: `@biomejs/biome` ^2.4.12 → ^2.4.13, `vitest` ^4.1.4 → ^4.1.5, `@vitest/coverage-istanbul` ^4.1.4 → ^4.1.5.

### Added

- **`scripts/check-docs-sync.ts`** and **`scripts/check-skills-sync.ts`** — sync-check scripts from framework 0.5.3 / 0.6.14, wired into `devcheck` as new `Docs Sync` and `Skills Sync` steps. Catches drift between `CLAUDE.md` / `AGENTS.md` and between `skills/` and its agent-mirror (`.claude/skills/`).
- **`skills/api-linter/`** (v1.1) — reference for every MCP definition lint rule (`format-parity`, `describe-on-fields`, `server-json-*`, etc.).
- **`skills/security-pass/`** (v1.1) — eight-axis security audit skill for pre-release review (injection vector, scope, input sinks, leakage, etc.).
- **`skills/release-and-publish/`** (v2.1) — post-wrapup ship workflow with retries for transient publish failures.

### Synced

- **19 project skills refreshed from framework 0.7.0**: `add-app-tool`, `add-prompt`, `add-resource`, `add-service`, `add-tool`, `api-config`, `api-context`, `api-services`, `api-utils`, `design-mcp-server`, `field-test`, `maintenance`, `polish-docs-meta`, `report-issue-framework`, `report-issue-local`, `setup`, plus the three new skills listed above.
- **`scripts/devcheck.ts`** and **`scripts/tree.ts`** synced from package — includes the 0.5.4 regex-sanitization CodeQL fix in the `esc()` helper.
- **`.claude/skills/`** mirror resynced to match `skills/` (Skills Sync devcheck step now green).

### Removed

- **`skills/devcheck/`** — removed from framework in 0.5.2 as a thin restatement of the Commands table. The command itself still prints a self-documenting summary; CLAUDE.md continues to reference `bun run devcheck` directly.

### Fixed

- **Issue template descriptions** (`.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`) — reference the scoped package name `@cyanheads/cdc-health-mcp-server` instead of the old identifier `cdc-health-statistics-mcp-server`.

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
