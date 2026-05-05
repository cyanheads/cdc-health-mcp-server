# Agent Protocol

**Server:** cdc-health-statistics-mcp-server
**Version:** 0.6.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

Wraps the [CDC Open Data portal](https://data.cdc.gov/) (~1,487 datasets) via the [Socrata SODA API v2.1](https://dev.socrata.com/). No auth required — optional app token for higher rate limits.

**Core workflow:** discover → inspect schema → query. The catalog is heterogeneous (disease surveillance, mortality, behavioral risk, vaccinations, environmental, injury, etc.), so the server provides a discovery-first approach rather than hard-coding dataset knowledge.

### API Surface

**Design doc:** `docs/design.md` — full parameter tables, error modes, API endpoints, and implementation notes.

| Definition | Type | Purpose |
|:-----------|:-----|:--------|
| `cdc_discover_datasets` | tool | Search catalog by keyword/category/tag. Entry point for all queries. |
| `cdc_get_dataset_schema` | tool | Fetch column schema, row count, metadata for a dataset ID. |
| `cdc_query_dataset` | tool | Execute SoQL queries — filter, aggregate, sort, full-text search. |
| `cdc://datasets` | resource | Top 50 datasets by popularity for orientation. |
| `cdc://datasets/{datasetId}` | resource | Dataset metadata + schema (equivalent to schema tool). |
| `analyze_health_trend` | prompt | Guided workflow: discover → inspect → query → compare → synthesize. |

### Socrata API Endpoints

| Endpoint | Purpose |
|:---------|:--------|
| `GET https://api.us.socrata.com/api/catalog/v1?domains=data.cdc.gov` | Discovery/catalog search |
| `GET https://data.cdc.gov/api/views/{datasetId}.json` | Dataset metadata + schema |
| `GET https://data.cdc.gov/resource/{datasetId}.json?$select=...&$where=...` | SoQL data queries |

### Quirks

- All SODA v2.1 response values are strings (including numbers/dates) — parse based on column type metadata.
- Dataset IDs are four-by-four format: `[a-z0-9]{4}-[a-z0-9]{4}` (e.g., `bi63-dtpu`).
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
8. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
9. **Run the `maintenance` skill** — sync skills and dependencies after framework updates

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. The framework catches, classifies, and formats. Prefer typed error contracts (`errors[]` + `ctx.fail`) for declared failure modes; fall back to error factories (`notFound()`, `validationError()`, etc.) for ad-hoc throws.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

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
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

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

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, re-copy to pick up changes.

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
| `field-test` | Exercise tools/resources/prompts via live HTTP + JSON-RPC, report findings |
| `tool-defs-analysis` | Read-only audit of definition language across the surface (10 categories) |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `security-pass` | Eight-axis security audit before release (injection, scope, input sinks, leakage, etc.) |
| `release-and-publish` | Post-wrapup ship workflow — npm, MCP Registry, GHCR |
| `maintenance` | Investigate, adopt, and verify dependency updates (framework changelog review + skill/script sync) |
| `migrate-mcp-ts-template` | Migrate a fork of mcp-ts-template to depend on the framework as a package |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas Tier 3 SQL/analytical workspace + `spillover()` helper (opt-in via CANVAS_PROVIDER_TYPE) |
| `api-config` | AppConfig, parseConfig, parseEnvConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, typed error contracts, error patterns |
| `api-linter` | Reference for every MCP definition lint rule (`format-parity`, `describe-on-fields`, `server-json-*`, etc.) |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests |
| `bun run start:stdio` | Production mode (stdio) — `bun run rebuild && bun run start:stdio` for dev smoke-tests |
| `bun run start:http` | Production mode (HTTP) — `bun run rebuild && bun run start:http` for dev smoke-tests |

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
- [ ] Handlers throw on failure — typed `errors[]` + `ctx.fail` for declared modes, factories or `Error` for ad-hoc; no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] Service-thrown errors carry contract `reason` via `data: { reason }` on factory calls when applicable
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
