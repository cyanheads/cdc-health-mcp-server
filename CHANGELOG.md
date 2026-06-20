# Changelog

## [0.6.12] - 2026-06-20

Framework maintenance: `@cyanheads/mcp-ts-core` ^0.10.6 → ^0.10.9, re-synced skills and devcheck scripts.

### Changed

- **`@cyanheads/mcp-ts-core` ^0.10.6 → ^0.10.9**: picks up the `ctx.content` collector for non-text content blocks (image/audio bytes ride `content[]` only, never `structuredContent`); Canvas SQL gate now classifies SELECT-shaped prepare failures as `invalid_sql` with the DuckDB binder column named in `data.binderMessage`; `DuckdbProvider.describe({ tableName })` ambiguous-column fix; and fresh-scaffold devcheck guards (changelog-sync and git-dependent checks skip cleanly before `git init`).
- **devcheck**: added the `check-dependency-specifiers` step (`scripts/check-dependency-specifiers.ts`) — hard-fails floating specifiers (`latest`/`*`/pre-release dist-tags) in `package.json` dependency sections and the `bun.lock` workspace map. Plugin-marketplace manifest validation (`.claude-plugin`/`.codex-plugin` descriptions, unscoped display names, full-scoped install args) added to `lint:packaging`, gated by the new `devcheck.config.json` `packaging.pluginManifests` flag.
- Re-synced framework-managed skills (`add-tool`, `api-canvas`, `api-config`, `api-context`, `api-telemetry`, `git-wrapup`, `orchestrations`, `polish-docs-meta`) and devcheck scripts to the 0.10.9 baseline.

### Dependencies

- `@cyanheads/mcp-ts-core` ^0.10.6 → ^0.10.9
- `@types/node` ^25.9.3 → ^26.0.0
- `@vitest/coverage-istanbul` ^4.1.8 → ^4.1.9
- `vitest` ^4.1.8 → ^4.1.9

## [0.6.11] - 2026-06-13

SoQL error-handling DX: cleaner 400 messages, recovery hints on schema lookups, and reserved-word guidance.

### Changed

- **SoQL 400 error normalization** (`socrata-service.ts`): `throwBadRequest` now normalizes `query.soql.column-not-in-group-bys` into `Column "{col}" must appear in GROUP BY or be wrapped in an aggregate...` using the structured `data.column` from the upstream response (falls back to `"unknown"`), and strips the trailing Scala `; position: Map(...)` debug dump from every un-mapped 400 message so agents act on the error without parsing internals. Parse failures (`query.compiler.malformed`) matching `Expected an expression, but got` now surface backtick-escaping guidance. The error-code lookup reads `errorCode` (Socrata's field for `query.soql.*` semantic errors) **or** `code` (its field for `query.compiler.*` parse errors). (#13, #11)
- **`cdc_query_dataset` `where` description**: documents that column names matching SoQL keywords (`group`, `select`, `where`, `order`, `limit`, `offset`, `having`, `search`) must be backtick-escaped, e.g. `` `group`='By Year' ``. (#11)
- **`docs/design.md`**: added "Column not in GROUP BY" and "Reserved-word column name" rows to the query error-mode table. (#13, #11)

### Fixed

- **Recovery hints on dataset-schema errors** (#10): `cdc_get_dataset_schema` and the `cdc://datasets/{datasetId}` resource called `getMetadata()` bare, so service-thrown `McpError`s bypassed the typed contract and `data.recovery.hint` never reached the wire. Both handlers now catch the reason-tagged `McpError` and re-throw via `ctx.fail(reason, ..., { ...ctx.recoveryFor(reason) })`, matching the pattern adopted for `cdc_query_dataset` in 0.6.9.

### Dependencies

- `@biomejs/biome` ^2.4.16 → ^2.5.0

## [0.6.10] - 2026-06-12

Framework adoption to `@cyanheads/mcp-ts-core` ^0.10.6, structured truncation enrichment, display-name fixes, and packaging/Docker hardening.

### Added

- **`cdc_query_dataset` structured truncation signal**: when `rowCount === input.limit`, the tool now emits the framework's `ctx.enrich.truncated()` helper with `truncated`/`shown`/`cap` enrichment fields plus a `notice`, replacing the prior free-text-only `notice`. Agents get a machine-readable flag alongside the pagination guidance.
- **Docker `HEALTHCHECK`**: bun-native `fetch` against `/healthz` (the slim runtime image ships no curl/wget); `ARG APP_VERSION` feeds the `org.opencontainers.image.version` OCI label.
- **`scripts/clean-mcpb.ts`**: post-pack MCPB bundle cleaner wired into the `bundle` script — runs `mcpb clean`, then strips dependency-shipped agent-doc trees (`skills/`, `.claude/`, `.agents/`, `SKILL.md`) nested under `node_modules/` that root-anchored `.mcpbignore` patterns cannot reach.

### Changed

- **Server display identity**: `createApp()` now sets `name` and `title` explicitly to `cdc-health-mcp-server`; corrected the stale `cdc-health-statistics-mcp-server` string in `CLAUDE.md` and the `src/index.ts` `@fileoverview`.
- **`.mcpbignore` patterns root-anchored** (`/skills/`, `/Dockerfile`, …) so they match only top-level entries rather than any nested path.
- **`check-framework-antipatterns.ts`**: added a rule flagging `z.coerce.boolean()` on env flags (`Boolean("false")` is `true`, so the flag can't be disabled via env — use `z.stringbool()`); comment lines are now skipped so documenting the pattern doesn't trip its own rule.
- **Skills**: synced to framework 0.10.6, plus the new `techniques` skill.

### Dependencies

- `@cyanheads/mcp-ts-core` ^0.9.21 → ^0.10.6
- `@types/node` ^25.9.1 → ^25.9.3
- `hono` 4.12.23 → 4.12.25 (transitive)
- `@modelcontextprotocol/ext-apps` 1.7.3 → 1.7.4 (transitive)

## [0.6.9] - 2026-06-04

Error contracts, truncation signals, and query DX improvements.

### Fixed

- **`cdc_query_dataset` service default**: `SocrataService.query()` internal `$limit` fallback corrected from 1000 to 100 to match the tool's documented and Zod-enforced default (#5).
- **`cdc_discover_datasets` invalid_query contract**: added missing `invalid_query` error contract entry covering HTTP 400 responses from the catalog API; updated `upstream_error` `when` description to accurately exclude 400 alongside 404/429 (#7).
- **`cdc_query_dataset` service errors lack recovery**: handlers for `cdc_query_dataset` and `cdc_discover_datasets` now wrap service-thrown `McpError` with `ctx.fail` + `ctx.recoveryFor()` so the declared contract recovery hint reaches wire clients in `data.recovery.hint` (#6).
- **`cdc_query_dataset` truncation blind spot**: emits a `notice` enrichment when `rowCount === input.limit`, signaling that results may be truncated and advising use of `offset` or a higher `limit` (#8).
- **`cdc_query_dataset` datasetId description**: added "Obtain from cdc_discover_datasets" cross-reference to the `datasetId` field description, matching the guidance already present in `cdc_get_dataset_schema` (#9).

### Changed

- **`cdc_query_dataset` success-path schema tip**: `format()` now appends a footer line pointing agents to `cdc_get_dataset_schema` on non-empty results, closing the guidance loop for unexpected filter behavior (#8).

## [0.6.8] - 2026-06-02

Framework adoption to `@cyanheads/mcp-ts-core` ^0.9.21, new `release:github` script, and skill sync from framework 0.9.16–0.9.21.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` `^0.9.16` → `^0.9.21`. User-facing changes across the range:
  - **HTTP transport per-request log context** (0.9.17) — per-request logs and traces now carry fresh request + trace/span IDs instead of the frozen boot context.
  - **`fetchWithTimeout` secret scrubbing** (0.9.18) — query-string secrets (e.g. `?api_key=`) stripped from error messages and logs.
  - **`withRetry` fail-fast** (0.9.19) — non-retryable errors abort immediately; `ctx.fail` auto-populates the `retryable` flag.
- **Skills**: synced from framework 0.9.16–0.9.21 (`add-tool`, `add-service`, `api-canvas`, `api-context`, `api-linter`, `api-utils`, `design-mcp-server`, `release-and-publish` + new `api-mirror`, `orchestrations`).
- **`scripts/devcheck.ts`**: updated devcheck script from framework 0.9.21.
- **README client-config keys**: renamed from `cdc-health` to the full package name `cdc-health-mcp-server` for consistency across config examples.
- **Plugin manifests**: `.claude-plugin/plugin.json` and `.codex-plugin/mcp.json` args simplified — redundant `run start:stdio` positional dropped.

### Dependencies

- `@cyanheads/mcp-ts-core` ^0.9.16 → ^0.9.21
- `@vitest/coverage-istanbul` ^4.1.7 → ^4.1.8
- `vitest` ^4.1.7 → ^4.1.8

## [0.6.7] - 2026-05-30

Enrichment adoption on `cdc_discover_datasets` and `cdc_query_dataset` — query echoes, result totals, and empty-result guidance now surface in a typed `enrichment` block reaching both the `structuredContent` JSON and the `content[]` markdown trailer.

### Changed

- **`cdc_discover_datasets`**: `totalCount` and `appliedFilters` moved from the `output` block into a typed `enrichment` block (`enrichment.totalCount`, `enrichment.appliedFilters`). Values are preserved and reach both channels. An `enrichment.notice` fires when no datasets match, echoing the applied filters and suggesting how to broaden the search.
- **`cdc_query_dataset`**: `query` field removed from the `output` block and re-surfaced as `enrichment.effectiveQuery` (renamed for clarity). An `enrichment.notice` fires when no rows match, with guidance on verifying filter values and broadening the WHERE clause.
- **Framework**: `@cyanheads/mcp-ts-core` `^0.9.13` → `^0.9.16`. User-facing changes across the range:
  - **Enrichment block** (0.9.14) — typed `enrichment`/`enrichmentTrailer` on `tool()` for agent-facing result context (totals, query echoes, notices). Reaches `structuredContent` and `content[]` automatically.
  - **`ctx.enrich` helpers** (0.9.14) — `.notice()`, `.total()`, `.echo()`, `.delta()` kind-tagged methods on the handler context.
  - **`ctx.enrich` always present** (0.9.15) — no presence-check required; typed via `HandlerContext<R, E>` when an `enrichment` block is declared.
  - **AGENTS.md template** (0.9.15) — `bunx @cyanheads/mcp-ts-core init` scaffolds AGENTS.md alongside CLAUDE.md.
  - **`api-linter` lint rules** (0.9.14–0.9.15) — enrichment contract validation added.
- **Skills**: synced from framework 0.9.13–0.9.16 (`add-tool`, `add-app-tool`, `add-service`, `api-context`, `api-linter`, `design-mcp-server`, `git-wrapup`, `maintenance`, `polish-docs-meta` + references, `setup`).

## [0.6.6] - 2026-05-28

Framework adoption to `@cyanheads/mcp-ts-core` ^0.9.13, HTTP transport hardening (413 body cap, session-init gate, quieter 401/403/400/404 logging), landing page inventory now public, GET /mcp surfaces package keywords, and description/keyword polish.

### Added

- **`landing.requireAuth: false`** in `src/index.ts` — keeps the tool/resource/prompt inventory visible to unauthenticated callers on the public hosted endpoint, consistent with `MCP_AUTH_MODE=none` behavior. Opt-in required after framework 0.9.10 changed the default to gated when auth is active.
- **`package.json` keywords**: `bun`, `stdio`, `streamable-http` added — surfaced on `GET /mcp` via framework 0.9.12.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` `^0.9.6` → `^0.9.13`. User-facing changes across the range:
  - **`MCP_HTTP_MAX_BODY_BYTES`** (0.9.13) — oversized inbound HTTP bodies rejected with 413 before the SDK parses them. Default 1 MiB; set to `0` to disable.
  - **HTTP session-init gate** (0.9.10) — stateful HTTP mode rejects requests without `Mcp-Session-Id` with 400, preventing uninitialized session minting.
  - **Quieter expected-error logging** (0.9.10) — 401, 403, 400, 404 responses now logged at `warning` level instead of running through the full error pipeline with stack traces.
  - **`GET /mcp` surfaces `package.json` keywords** (0.9.12) — discovery metadata richer for tool-registry clients.
- **`package.json` description**: updated to lead with concrete data domains (mortality, vaccinations, surveillance, behavioral risk).
- **`server.json` description**: trimmed to remove "Socrata SODA API" implementation detail — description now reads as user-facing scope.
- **Dev dependencies**: `@biomejs/biome` ^2.4.15 → ^2.4.16.

### Synced

- Skills refreshed from framework 0.9.7–0.9.13: `api-canvas`, `api-config`, `design-mcp-server`, `polish-docs-meta` (with references), `release-and-publish`, `report-issue-framework`. `migrate-mcp-ts-template` removed (migration era complete). `code-simplifier` and `git-wrapup` added as new skills.
- `.claude-plugin/` and `.codex-plugin/` plugin metadata directories scaffolded.

## [0.6.5] - 2026-05-23

Framework refresh to `@cyanheads/mcp-ts-core` ^0.9.6, `zod` promoted to a direct dependency, `publish-mcp` script, `manifest.json` + `.mcpbignore` scaffolded for MCPB bundle support, install badges added to README, and action-first description rewrites across tools.

### Changed

- **Framework**: `@cyanheads/mcp-ts-core` `^0.9.1` → `^0.9.6`. Picks up fixes and polish across the 0.9.x patch series.
- **`zod`**: promoted from implicit transitive to direct dependency `^4.4.3`. Zod is used directly in tool/resource schemas; the explicit entry prevents accidental version skew when the framework updates its own peer.
- **Dev dependencies**: `@types/node` `^25.8.0` → `^25.9.1`, `@vitest/coverage-istanbul` and `vitest` `^4.1.6` → `^4.1.7`.
- **`package.json` `description`**: `"MCP server for discovering and querying CDC public health datasets via the Socrata SODA API."` → `"Discover and query CDC public health datasets via the Socrata SODA API via MCP. STDIO or Streamable HTTP."` — action-first, surfaces both transport modes.
- **`package.json` `files`**: `manifest.json` and `.mcpbignore` added to the published set so MCPB bundles include them.
- **`scripts/devcheck.ts`**: `bun outdated` parser updated (upstream format changes).
- **README badge row**: consolidated to a single line; `Docker`, `TypeScript`, and `Bun` badges added; badge order updated for scan consistency.

### Added

- **`publish-mcp` script** in `package.json`: `bun run build && npm publish --access public` — one-step publish after a clean build.
- **`bundle` script** in `package.json`: `bun run build && npx -y @anthropic-ai/mcpb pack ...` — produces a `.mcpb` extension bundle for one-click Claude Desktop install.
- **`manifest.json`**: MCPB manifest scaffolded with env var declarations for `CDC_APP_TOKEN` and `MCP_LOG_LEVEL`.
- **`.mcpbignore`**: excludes non-bundle files from the packed `.mcpb` artifact.
- **Install badges** in README: Claude Desktop `.mcpb` install, Cursor deep-link, VS Code MCP install.

### Synced

- **Skills refreshed from framework 0.9.x**: `field-test` 2.4 → 2.5, `maintenance` 2.1 → 2.2, `polish-docs-meta` 1.8 → 1.9, `release-and-publish` 1.x → latest.
- **`.claude/skills/`** mirror resynced to match `skills/`.

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
