# Agent Protocol

**Server:** cdc-health-statistics-mcp-server
**Version:** 0.4.3
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

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const getDatasetSchema = tool('cdc_get_dataset_schema', {
  description: 'Fetch the full column schema for a CDC dataset.',
  annotations: { readOnlyHint: true },
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

  // format() populates content[] — the only field most LLM clients forward to
  // the model. Render all data the LLM needs, not just a count or title.
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

const ServerConfigSchema = z.object({
  appToken: z.string().optional().describe('Socrata app token for higher rate limits'),
  baseUrl: z.string().url().default('https://data.cdc.gov').describe('Base URL for SODA API requests'),
  catalogUrl: z.string().url().default('https://api.us.socrata.com/api/catalog/v1').describe('Discovery API URL'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= ServerConfigSchema.parse({
    appToken: process.env.CDC_APP_TOKEN,
    baseUrl: process.env.CDC_BASE_URL,
    catalogUrl: process.env.CDC_CATALOG_URL,
  });
  return _config;
}
```

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

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, forbidden, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

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
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Sync skills and dependencies after updates |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
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
| `bun run dev:stdio` | Dev mode (stdio) |
| `bun run dev:http` | Dev mode (HTTP) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, etc.)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`)
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — `content[]` is the only field most clients forward to the model
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes
