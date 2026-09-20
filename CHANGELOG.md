# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.9.0](changelog/0.9.x/0.9.0.md) — 2026-09-20 · 🛡️ Security

New cdc_list_catalog_vocabulary tool, live row counts on cdc_get_dataset_schema, and fixes for chart/map queries and double-decoded HTML descriptions.

## [0.8.7](changelog/0.8.x/0.8.7.md) — 2026-09-16

Adopts mcp-ts-core 0.13.2: sessionMode is now declared in src/index.ts and published on the server card, argument rejections carry a -32602 structured error, shutdown exits explicitly, and the changelog moves to a per-version directory layout.

## [0.8.6](changelog/0.8.x/0.8.6.md) — 2026-08-22

Adopts `@cyanheads/mcp-ts-core` 0.12.3 and with it the MCP SDK v2 line: tool inputs are strict, advertised schemas are JSON Schema 2020-12, `outputSchema` declares the error envelope, and every HTTP endpoint serves protocol revision `2026-07-28` alongside the 2025 era. No tool, resource, or prompt behavior changed — `src/` is untouched.

## [0.8.5](changelog/0.8.x/0.8.5.md) — 2026-08-18

Truthful pagination for `cdc_query_dataset`, windowed column retrieval for `cdc_get_dataset_schema` and its resource twin, and row pagination for `cdc_query_wonder` — all three now share the same `truncated`/`totalCount`/`nextOffset` continuation vocabulary.

## [0.8.4](changelog/0.8.x/0.8.4.md) — 2026-08-09

Corrects the `domain` input's description on the three Socrata tools, which implied `chronicdata.cdc.gov` scoped access to datasets it does not, and closes a token-leak test that could never fail.

## [0.8.3](changelog/0.8.x/0.8.3.md) — 2026-08-09

`cdc_query_wonder` now spans five CDC WONDER mortality databases instead of one, with a corrected request-spacing gate and disclosure of rows CDC hides from the response.

## [0.8.2](changelog/0.8.x/0.8.2.md) — 2026-08-09

Error contract corrections across the Socrata endpoints, a catalog `assetType`/`not_queryable` distinction for non-tabular assets, and CDC WONDER routing added to the `analyze_health_trend` prompt.

## [0.8.1](changelog/0.8.x/0.8.1.md) — 2026-08-09

`cdc_query_wonder` fixes: CDC status tokens no longer read as suppression, every caveat renders, unresolved template placeholders are filtered out, and single-age-group filters no longer fail upstream.

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-07-11

Adds `cdc_query_wonder`, a fourth tool covering CDC WONDER national mortality statistics.

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-07-10

Four query/discovery/catalog bug fixes, plus `@cyanheads/mcp-ts-core` ^0.10.14 adoption and supply-chain hardening.

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-06-21

Multi-portal access via an allowlisted `domain` input, plus a leaner discovery payload.

## [0.6.11](changelog/0.6.x/0.6.11.md) — 2026-06-13

SoQL error-handling DX: cleaner 400 messages, recovery hints on schema lookups, and reserved-word guidance.

## [0.6.10](changelog/0.6.x/0.6.10.md) — 2026-06-12

Framework adoption to `@cyanheads/mcp-ts-core` ^0.10.6, structured truncation enrichment, display-name fixes, and packaging/Docker hardening.

## [0.6.9](changelog/0.6.x/0.6.9.md) — 2026-06-04

Error contracts, truncation signals, and query DX improvements.

## [0.6.8](changelog/0.6.x/0.6.8.md) — 2026-06-02

Framework adoption to `@cyanheads/mcp-ts-core` ^0.9.21, new `release:github` script, and skill sync from framework 0.9.16–0.9.21.

## [0.6.7](changelog/0.6.x/0.6.7.md) — 2026-05-30

Enrichment adoption on `cdc_discover_datasets` and `cdc_query_dataset` — query echoes, result totals, and empty-result guidance now surface in a typed `enrichment` block reaching both the `structuredContent` JSON and the `content[]` markdown trailer.

## [0.6.6](changelog/0.6.x/0.6.6.md) — 2026-05-28

Framework adoption to `@cyanheads/mcp-ts-core` ^0.9.13, HTTP transport hardening (413 body cap, session-init gate, quieter 401/403/400/404 logging), landing page inventory now public, GET /mcp surfaces package keywords, and description/keyword polish.

## [0.6.5](changelog/0.6.x/0.6.5.md) — 2026-05-23

Framework refresh to `@cyanheads/mcp-ts-core` ^0.9.6, `zod` promoted to a direct dependency, `publish-mcp` script, `manifest.json` + `.mcpbignore` scaffolded for MCPB bundle support, install badges added to README, and action-first description rewrites across tools.

## [0.6.4](changelog/0.6.x/0.6.4.md) — 2026-05-16

Framework refresh to `@cyanheads/mcp-ts-core` 0.9.1. Adopts the new server-level `instructions` field and `httpErrorFromResponse` utility, gains the portability lint rules from 0.9.x at build time, and syncs project skills from upstream. No tool/resource/prompt API changes.

## [0.6.3](changelog/0.6.x/0.6.3.md) — 2026-05-08

Definition-language polish across every tool, resource, and prompt — driven by a `tool-defs-analysis` audit. Tightens query defaults, removes display truncation that hid data from the LLM, fills in a missing error contract on `cdc://datasets`, and drops a duplicate dataset-ID validation that the Zod schema already enforces at the edge.

## [0.6.2](changelog/0.6.x/0.6.2.md) — 2026-05-08

Framework refresh to `@cyanheads/mcp-ts-core` 0.8.19 — the HTTP SSE per-request retention leak fix, the `ctx.sessionId` and `ctx.auth.token` surfacing fixes, and the engines bump to Bun ≥1.3.0 / Node ≥24.0.0. No tool, resource, or prompt code changes.

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-05-05

Framework upgrade to `@cyanheads/mcp-ts-core` 0.8.15 and adoption of the new typed error contracts on every tool, resource, and the Socrata service layer.

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-04-24

Framework upgrade to `@cyanheads/mcp-ts-core` 0.7.0, adoption of the new `parseEnvConfig` helper for env-var-aware startup errors, and internal cleanup.

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-04-19

Framework upgrade to `@cyanheads/mcp-ts-core` 0.4.1, honest handling of sparse upstream data, and skill sync.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-04-04

Richer discovery output, simplified tool handlers, and service cleanup.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-04-04

Added public hosted instance, updated dev dependencies.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-04-03

Support non-string Socrata column values (GeoJSON, numbers) in query results.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-04-03

README rewrite, Dockerfile cleanup, binary rename, and project metadata improvements.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-04-03

Packaging overhaul, npm scope rename, and project metadata hardening.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-04-03

Diagnostics echo, structured Socrata error messages, and discovery refinements.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-04-03

Field-test-driven fixes for data accuracy, discovery relevance, and developer guidance.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-04-03

Initial release. MCP server for discovering and querying CDC public health datasets via the Socrata SODA API.
