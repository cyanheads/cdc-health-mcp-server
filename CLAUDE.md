# Agent Protocol

**Server:** cdc-health-mcp-server
**Version:** 0.8.6
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.12.3`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

Wraps the [CDC Open Data portal](https://data.cdc.gov/) (~1,080 datasets) via the [Socrata SODA API v2.1](https://dev.socrata.com/). No auth required — optional app token for higher rate limits.

**Core workflow:** discover → inspect schema → query. The catalog is heterogeneous (disease surveillance, mortality, behavioral risk, vaccinations, environmental, injury, etc.), so the server provides a discovery-first approach rather than hard-coding dataset knowledge.

### API Surface

**Design doc:** `docs/design.md` — full parameter tables, error modes, API endpoints, and implementation notes.

The three Socrata tools take an allowlisted `domain` input (`data.cdc.gov` default, `chronicdata.cdc.gov`) — Zod `z.enum` rejects any other host before the handler runs (the SSRF guard). The two `cdc://datasets…` resources stay on the default host. `cdc_query_wonder` hits a different CDC system and takes no `domain`; its `database` enum picks the dataset code in the upstream path, and is the same kind of guard.

| Definition | Type | Purpose |
|:-----------|:-----|:--------|
| `cdc_discover_datasets` | tool | Search catalog by keyword/category/tag. Entry point. Trimmed payload — `assetType`, `columnCount` + an 8-name `columnSample` and a 300-char description; full column detail comes from `cdc_get_dataset_schema`. |
| `cdc_get_dataset_schema` | tool | Fetch column schema, row count, metadata for a dataset ID. Full-detail surface, windowed — `column_limit` (default 100, max 500) / `column_offset`, with `totalCount`/`truncated`/`nextOffset` enrichment. Fails `not_queryable` on a non-tabular asset instead of returning empty columns. |
| `cdc_query_dataset` | tool | Execute SoQL queries — filter, aggregate, sort, full-text search. Continuation is measured by an over-fetch probe, not the row count, and the page is bounded by a character budget; discloses `truncated`/`shown`/`cap`/`nextOffset`, never a `totalCount`. |
| `cdc_query_wonder` | tool | Query CDC WONDER for national deaths, population, crude/age-adjusted rates. Grouped by year/age/sex/race, filtered by ICD-10 cause. A `database` enum selects one of five mortality databases — D76 (default), D176 provisional, D158, D77, D157. Whole table by default; `limit`/`offset` page the parsed rows with `totalCount`/`truncated`/`nextOffset`, re-basing `cellNotes` onto the page while `caveats`/`messages` stay whole. |
| `cdc://datasets` | resource | 50 most-viewed catalog entries for orientation — carries `assetType` + `columnCount`, since the page mixes charts/stories/filters in with datasets. |
| `cdc://datasets/{datasetId}` | resource | Dataset metadata + the first 100 columns, carrying `columnCount`/`truncated`/`notice`. Takes no selector — the SDK's `UriTemplate.match` compiles RFC 6570 query variables as *required*, so `{?column_limit,column_offset}` would stop the bare URI matching at all. |
| `analyze_health_trend` | prompt | Guided workflow: pick the source (WONDER for national mortality, Socrata otherwise), then discover → inspect → query → compare → synthesize. Routing is prose the reader acts on — the handler never classifies the topic. |

### Socrata API Endpoints

`{domain}` is allowlisted to `data.cdc.gov` (default) or `chronicdata.cdc.gov`, selected per call via the `domain` tool input. The two are front doors onto one Socrata tenant — a single catalog labelled `data.cdc.gov`, whose assets all resolve by four-by-four ID on either host — so `domain` picks which host answers, never which assets are reachable. No surface may name PLACES, the Heart Disease & Stroke Atlas, or Environmental Public Health Tracking as though `chronicdata.cdc.gov` were the way to reach them; `tests/services/socrata/socrata-domain-semantics.test.ts` pins that. The app token works unchanged across both hosts.

| Endpoint | Purpose |
|:---------|:--------|
| `GET https://api.us.socrata.com/api/catalog/v1?domains={domain}` | Discovery/catalog search |
| `GET https://{domain}/api/views/{datasetId}.json` | Dataset metadata + schema |
| `GET https://{domain}/resource/{datasetId}.json?$select=...&$where=...` | SoQL data queries |

### CDC WONDER API

Separate system, separate service (`src/services/wonder/`). `POST https://wonder.cdc.gov/controller/datarequest/<ID>` with a form-urlencoded `request_xml` document; the response is an XML `<data-table>`.

- Five mortality databases behind one tool, keyed by the `database` enum: `D76` (default, 1999–2020), `D176` (provisional, 2018 → current year), `D158` (2018–2024), `D77` and `D157` (multiple-cause). `WONDER_DATABASE_SPECS` in `types.ts` is the source of truth for IDs, titles, spans, race variable, and multiple-cause support.
- **Build each database's fixed-parameter block from its own request form**, never by templating D76's — a prefix swap returns HTTP 500 (`The second box of the AND combination for '{0}' contains an entry while the first one is empty`). `POST /controller/datarequest/<ID>` with `stage=about&action-I Agree=I Agree` returns the form; `SCAFFOLDS` in `xml-builder.ts` is transcribed from it. Multiple-cause finders need paired `V_*.V13`/`V_*.V13_AND` textareas; `D176` carries occurrence-location, MMWR and 2023-urbanization variables D76 lacks and omits D76's weekday variable.
- `race` is the only dimension that diverges — `.V8` bridged (4 groups) on the 1999–2020 pair, `.V42` single race (6 groups) on the rest. The two families' series are not comparable, and every surface naming `race` says so.
- Age-adjusted rate comes from `O_aar=aar_std`, not a measure code — no mortality database has an `M4`. Only `M_1..M_3` are ever sent.
- IDs are pinned, not resolved per call. `GET /controller/datarequest/<ID>` names the request page an ID belongs to and a retired ID names none — checked by `tests/services/wonder/database-ids.test.ts` under `WONDER_LIVE_TESTS=1`, which costs no rate-limited POST.
- Per-database year spans and the `mcd_icd10`-needs-a-multiple-cause-database rule are enforced **in the handler**, not a Zod `refine` — a refinement adds nothing to the emitted JSON Schema and fails as a raw `ZodError` at the transport, out of reach of the declared `recovery`. Same pattern #27 established for `cdc_discover_datasets`.
- Send bare headers — a browser-looking User-Agent/Origin trips an upstream Akamai 403.
- Hard 16-second gap between requests, enforced by the service (429 otherwise). It is measured from the end of the previous response, not from when its request was issued — WONDER rejects a request sent 15 s after the previous one started. The stamp lives in `query()`'s `finally`, so the network-error, 429, and malformed-body paths space the next call too. The limit is per source IP and shared across databases: one process-wide gap, never a per-database limiter.
- National only; sub-national grouping and filtering are blocked by CDC policy.
- Every request must carry a rate measure — a deaths-only measure set is rejected.
- Cause of death is a filter, never a grouping.
- Age-adjusted rate is rejected unless age can be standardized — omit it when `age_group` is a grouping dimension or the age-group filter selects exactly one group.
- Every input that mirrors a `V_*` option list carries the whole list — `age_groups` includes `NS`, and both cause filters accept `999--999` (the provisional database's withheld-cause marker, rejected by the other four in the handler). The variables the tool omits entirely are omitted by decision, not oversight; `docs/design.md` holds the table and the reasoning.
- A measure cell may carry a status token instead of a number: `Suppressed`, `Unreliable`, `Not Applicable`. The parser nulls the value and records the token per cell.
- Dimension labels come back as CDC's own text with surrounding whitespace trimmed (`dimensionLabel` in `xml-parser.ts`) — D158 and D157 pad their last year as `2024 `, which splits one year into two keys in a cross-database comparison. Nothing inside a label is touched: `2025 (provisional)` stays intact.
- Whole rows are hidden by default (zero deaths, suppressed deaths) and leave no trace in the table. WONDER says so in `<message>` elements on the 200, which `messages` carries verbatim. `fixedParams()` deliberately does not send `O_show_zeros`/`O_show_suppressed` — unhiding changes the result set materially and needs its own design pass (rationale in `docs/design.md`).

### Quirks

- All SODA v2.1 response values are strings (including numbers/dates) — parse based on column type metadata.
- Dataset IDs are four-by-four format: `[a-z0-9]{4}-[a-z0-9]{4}` (e.g., `bi63-dtpu`).
- The catalog returns `chart`, `map`, `story`, `file`, and `href` assets alongside datasets, all with four-by-four IDs. **`columns.length === 0` from the metadata call is the queryability signal — not `resource.type` and not `viewType`.** A `filter` asset has real columns and queries fine; `chart` and `map` report `viewType: "tabular"` with zero columns.
- `fetchJson` is shared by all five Socrata definitions and each handler re-dispatches on `err.data.reason` alone, so a reason must be true for every status it covers **and** declared by every consumer that can raise it — `ctx.fail` with an undeclared reason returns an `InternalError` that leaks the declared-reason list. `tests/services/socrata/socrata-contract-parity.test.ts` enforces both directions; the status→reason table lives in `docs/design.md`.
- Anything upstream interpolated into a markdown table cell goes through `escapeTableCell` (`src/utils/markdown.ts`) — Socrata column descriptions carry raw newlines, which terminate the row for `content[]`-only clients.
- The Discovery API unions `tags` — one parameter per value, matched against the catalog's own vocabulary case-insensitively. Adding a tag widens the result set, and a tag no dataset carries matches nothing and changes nothing. `query` and `category` intersect with it. Every surface naming tags says so: the input `.describe()`, the `appliedFilters` trailer, `README.md`, and `docs/design.md`.
- `SocrataService.query` sends `$limit + 1` on the wire and drops the extra row — the SODA data endpoint reports no total, so the over-fetch is the only thing that separates a last page which fills the limit exactly from one that was cut. The echoed `query` is built **before** the probe overwrites `$limit`, so it stays the caller's own; handing back the probe value would give anyone replaying the echo one extra row per call. `tests/services/socrata/socrata-service.test.ts` pins both halves.
- `QueryResult.query` (the `effectiveQuery` echo) is read back off `URLSearchParams` rather than decoded from its output — that form writes a space as `+` and a caller's literal `+` as `%2B`, so decoding it strands every space as a plus sign and swapping plus for space afterwards erases the arithmetic `+`.
- Year columns vary per dataset — some are numbers, some text. `where` clause must match the actual type.
- Some datasets suppress small counts for privacy (missing values or footnote markers, not zeros).
- No rate-limit headers returned — implement conservative request spacing (200-500ms).

### Server Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CDC_APP_TOKEN` | No | — | Socrata app token for higher rate limits |
| `CDC_BASE_URL` | No | `https://data.cdc.gov` | Base URL for SODA API requests |
| `CDC_CATALOG_URL` | No | `https://api.us.socrata.com/api/catalog/v1` | Base URL for Socrata Discovery API |

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const getDatasetSchema = tool('cdc_get_dataset_schema', {
  description: 'Fetch the full column schema for a CDC dataset.',
  annotations: { readOnlyHint: true },

  errors: [
    { reason: 'dataset_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'Dataset ID does not exist or has been retired.',
      recovery: 'Search again with cdc_discover_datasets to find a current ID.' },
  ],

  input: z.object({
    datasetId: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/).describe('Four-by-four dataset identifier.'),
  }),
  output: z.object({
    name: z.string().describe('Dataset name.'),
    columns: z.array(z.object({
      fieldName: z.string().describe('Column field name.'),
      dataType: z.string().describe('Column data type.'),
    })).describe('Dataset columns.'),
  }),

  async handler(input, ctx) {
    const metadata = await getSocrataService().getMetadata(input.datasetId, ctx.signal);
    ctx.log.info('Schema retrieved', { datasetId: input.datasetId });
    return metadata;
  },

  // Different MCP clients read different surfaces — Claude Code reads
  // structuredContent, Claude Desktop reads content[]. format() is the
  // markdown twin of structuredContent and must carry the same data.
  format: (result) => [{
    type: 'text',
    text: [`## ${result.name}`, ...result.columns.map(c => `- \`${c.fieldName}\` (${c.dataType})`)].join('\n'),
  }],
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const datasetDetailResource = resource('cdc://datasets/{datasetId}', {
  description: 'Dataset metadata and column schema for a specific CDC dataset.',
  mimeType: 'application/json',
  params: z.object({
    datasetId: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/).describe('Four-by-four dataset identifier.'),
  }),
  async handler(params, ctx) {
    const metadata = await getSocrataService().getMetadata(params.datasetId, ctx.signal);
    ctx.log.info('Dataset detail accessed', { datasetId: params.datasetId });
    return metadata;
  },
});
```

### Prompt

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const analyzeHealthTrend = prompt('analyze_health_trend', {
  description: 'Guided workflow for investigating a public health question across CDC data.',
  args: z.object({
    topic: z.string().describe('Health topic to investigate.'),
    timeRange: z.string().optional().describe('Period of interest (e.g., "2015-2023").'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Investigate: ${args.topic}${args.timeRange ? ` (${args.timeRange})` : ''}` } },
  ],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  appToken: z.string().optional().describe('Socrata app token for higher rate limits'),
  baseUrl: z.string().url().default('https://data.cdc.gov').describe('Base URL for SODA API requests'),
  catalogUrl: z.string().url().default('https://api.us.socrata.com/api/catalog/v1').describe('Discovery API URL'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    appToken: 'CDC_APP_TOKEN',
    baseUrl: 'CDC_BASE_URL',
    catalogUrl: 'CDC_CATALOG_URL',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`CDC_APP_TOKEN`) rather than the internal path (`appToken`).

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.getMany(keys)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | Reader over a retried request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped`. Empty on the first round. |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.enrich` | Success-path enrichment — accumulates agent-facing context (notices, totals, query echo) onto the request. Reaches `structuredContent` + `content[]` automatically. Kind-tagged helpers: `.notice(text)`, `.total(n)`, `.echo(query)`, `.delta({ field, before, after })`. Always present; typed on `HandlerContext<R, E>` when an `enrichment` block is declared. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated) — the contract is the single source of truth. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely without declaring.

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query.',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`, { ...ctx.recoveryFor('no_match') });
  return item;
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — per-tool repetition is the intended cost of locality. Don't extract a shared `errors[]` constant.

**Service-thrown errors** carry contract `reason` via `data: { reason }` on the factory call — services don't have `ctx.fail`. The auto-classifier preserves `data` so clients see the same shape.

**Fallback** for ad-hoc throws (no contract entry fits, prototype tools, service-layer code):

```ts
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, factory list, and contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    [domain]/
      [domain]-service.ts               # Domain service (init/accessor pattern)
      types.ts                          # Domain types
  utils/
    markdown.ts                         # escapeTableCell — shared by every format()
  mcp-server/
    tools/definitions/
      [tool-name].tool.ts               # Tool definitions
    resources/definitions/
      [resource-name].resource.ts       # Resource definitions
    prompts/definitions/
      [prompt-name].prompt.ts           # Prompt definitions
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `discover-datasets.tool.ts` |
| Tool/resource/prompt names | snake_case | `cdc_discover_datasets` |
| Directories | kebab-case | `src/services/socrata/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search the CDC dataset catalog by keyword.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, parseEnvConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, typed error contracts, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe rules only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run list-skills` | Print the skill registry |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create GitHub Release from the current tag |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with Istanbul coverage |
| `bun run start:stdio` | Production mode (stdio) — `bun run rebuild && bun run start:stdio` for dev smoke-tests |
| `bun run start:http` | Production mode (HTTP) — `bun run rebuild && bun run start:http` for dev smoke-tests |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` to skip; `lint:packaging` skips cleanly when `manifest.json` is absent.

**Adding an env var requires both files:** `server.json` (`environmentVariables[]`) and `manifest.json` (`mcp_config.env` + `user_config`). `lint:packaging` (wired into `devcheck`) verifies alignment.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

This server uses a monolithic `CHANGELOG.md` (no `changelog/` directory). Edit it directly at each release. The devcheck changelog-sync step skips cleanly when no `changelog/` directory is present, and the `changelog:build` / `changelog:check` scripts are absent for the same reason.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries. Open each version block with a human-readable headline.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` in the framework package for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getSocrataService } from '@/services/socrata/socrata-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
