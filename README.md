<div align="center">
  <h1>@cyanheads/cdc-health-mcp-server</h1>
  <p><b>Search and query CDC public health data — mortality, vaccinations, surveillance, behavioral risk (Socrata SODA API) via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cdc-health-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cdc-health-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cdc-health-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cdc-health-mcp-server/releases/latest/download/cdc-health-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cdc-health-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2RjLWhlYWx0aC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cdc-health-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/cdc-health-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cdc.caseyjhand.com/mcp](https://cdc.caseyjhand.com/mcp)

</div>

---

## Overview

CDC public health data — the Socrata-based CDC Open Data portal, plus CDC WONDER, a separate CDC system for national mortality statistics. Search the catalog, inspect dataset schemas, and run SoQL queries across vaccination, surveillance, and behavioral-risk data, or query WONDER for deaths, population, and death rates by year, age, sex, and race. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `cdc_discover_datasets` | Search the CDC dataset catalog by keyword, category, or tag |
| `cdc_get_dataset_schema` | Fetch column schema, row count, and metadata for a dataset |
| `cdc_list_catalog_vocabulary` | List the catalog's category and tag values with their entry counts |
| `cdc_query_dataset` | Execute SoQL queries — filter, aggregate, sort, full-text search, select fields |
| `cdc_query_wonder` | Query CDC WONDER for national mortality, population, and death rates across five databases |

### Resources

| Resource | Description |
|:---|:---|
| `cdc://datasets` | Top 50 most-viewed catalog entries, for orientation |
| `cdc://datasets/{datasetId}` | Dataset metadata and the first 100 columns for a specific dataset |

Both resources mirror data also reachable via `cdc_discover_datasets` and `cdc_get_dataset_schema`, for clients that surface resources but not tools.

### Prompts

| Prompt | Description |
|:---|:---|
| `analyze_health_trend` | Guided workflow for investigating a public health question across CDC data |

## Capability reference

### `cdc_discover_datasets` <sub>tool</sub>

- `domain` selects `data.cdc.gov` (default) or `chronicdata.cdc.gov` — both front the same catalog, so switching hosts neither widens nor narrows a search
- `query`, `category`, and `tags` filters — tags union (a dataset matches on any one tag, so each tag added widens the result set), while `query` and `category` intersect with the tag set
- Up to 100 results per page (default 10); `offset` is capped at 9999, and `offset + limit` must not exceed 10,000 — Socrata's catalog ceiling
- `order`: `dataset_id` (default) sorts deterministically for stable pagination; `relevance` ranks by best match but is not stably paginable across pages
- Each result carries `columnCount` — a value of 0 marks a non-tabular asset (chart, map, story, file, or href) that yields no data from the other tools; `assetType` is descriptive only
- `description` is converted to plain text before it is cut to 300 characters, so the budget buys visible text rather than the HTML tags catalog entries arrive wrapped in
- Enrichment carries `totalCount` and `appliedFilters`; a `notice` distinguishes an offset past the end of the result set from a search that matched nothing, and resolves a `category`/`tags` value that matched nothing against the catalog vocabulary — `category: "Vaccination"` comes back naming `"Vaccinations" (89 datasets)` rather than advising a broader search. The vocabulary is read only on that branch, so an ordinary search costs no extra request

---

### `cdc_get_dataset_schema` <sub>tool</sub>

- Accepts a four-by-four `datasetId` (e.g. `bi63-dtpu`) and the same `domain` enum as the other Socrata tools
- Returns the first 100 columns by default (`column_limit`, max 500) — catalog schemas run 3 to 322 columns, so ordinary datasets arrive whole; wider ones report `totalCount`, `truncated`, and `nextOffset` to pass back as `column_offset`
- A `column_offset` at or past the column count returns an empty window rather than an error
- Fails with `not_queryable` when the ID names a non-tabular catalog asset, rather than returning an empty column list
- `rowCount` prefers a live `count(*)` fetched alongside the metadata; `rowCountSource` says `live` or `cached`, since Socrata's cached figure is built once and can understate an actively-updated dataset by a third or more. A failed count falls back to the cached figure and never fails the schema response
- `description` is returned in full as plain text — markup stripped, entity references decoded; only `cdc_discover_datasets` truncates it

---

### `cdc_list_catalog_vocabulary` <sub>tool</sub>

- The controlled vocabularies `cdc_discover_datasets`' `category` and `tags` filters are matched against — a value the catalog does not carry matches nothing, which is indistinguishable from a real value with no results
- All 55 categories return whole (~3 KB); the tag vocabulary runs to 1,583 values, so tags are ranked by entry count and paged with `tag_limit` (default 50, max 500) and `tag_offset`
- The service asks the tag endpoint for the whole vocabulary explicitly — left to its default it returns 100 values and reports `resultSetSize: 100` beside them, so the under-count reads as complete
- `filter` narrows both vocabularies before the page is cut, matching on whole words in either direction (`"vaccin"` reaches `Vaccinations` and `covid-19 vaccination`). Not fuzzy — a misspelling returns nothing rather than a guess
- Enrichment carries `vocabularySize`, the matched `categoryCount`/`tagCount`, and `truncated`/`shown`/`cap`/`nextOffset`; `truncationCeiling` bounds every omitted tag, since the list is ranked by the same count
- Both hosts publish the same vocabulary — measured live, `data.cdc.gov` and `chronicdata.cdc.gov` return the identical 55 categories and 1,583 tags

---

### `cdc_query_dataset` <sub>tool</sub>

- Full SoQL support — `select`, `where`, `group`, `having`, `order`, plus full-text `search` across text columns
- Up to 5,000 rows per request (default 100); `offset` capped at 1,000,000
- `truncated` is measured by an over-fetch probe (one row past the limit), never guessed from the row count; the whole response — `structuredContent` and `content[]` together — is bounded by a 200,000-character budget, so a wide page can end short of `limit` with a `nextOffset`
- An empty page at `offset > 0` is diagnosed with one probe at offset 0: the `notice` says whether the offset ran past the end or the query matches nothing, and names both causes if the probe fails
- `effectiveQuery` echoes the SoQL clauses sent in their original text, not URL-encoded, so a clause can be copied back into the parameter it came from
- Fails with `not_queryable` when every returned row carries no fields and the asset reports no columns — a chart or map ID, which Socrata answers 200 with a body of empty objects. When the asset does have columns, the same shape is a null-only projection and comes back as a success with a notice
- All response values are strings (SODA v2.1) — parse per the column's `dataType` from the schema

---

### `cdc_query_wonder` <sub>tool</sub>

`database` selects which of five mortality databases answers the query:

| Value | CDC database | Years | Race groups | `mcd_icd10` |
|:---|:---|:---|:---|:---|
| `underlying_1999_2020` *(default)* | D76 — Underlying Cause of Death | 1999–2020 | 4 bridged | — |
| `provisional` | D176 — Provisional Mortality Statistics | 2018 → current year | 6 single-race | yes |
| `underlying_2018_2024` | D158 — Underlying Cause of Death, Single Race | 2018–2024 | 6 single-race | — |
| `multiple_1999_2020` | D77 — Multiple Cause of Death | 1999–2020 | 4 bridged | yes |
| `multiple_2018_2024` | D157 — Multiple Cause of Death, Single Race | 2018–2024 | 6 single-race | yes |

- `group_by`: 1–4 of `year`, `age_group`, `sex`, `race`; national totals only — no sub-national breakdown at any setting
- `mcd_icd10` matches a cause recorded anywhere on the death certificate rather than only the underlying cause; accepted only by `provisional`, `multiple_1999_2020`, and `multiple_2018_2024` — the others reject it
- `age_groups` must include `"NS"` (age not recorded) to match an unfiltered total; a `year_range` outside the selected database's span is rejected with that span named
- Measure cells CDC withholds or flags (`Suppressed`, `Unreliable`, `Not Applicable`) read `null` in `rows` and are named per cell in `cellNotes`; whole rows CDC hides (zero or suppressed deaths) are absent from `rows` with no gap marker — check `messages`
- Returns the whole table by default; `limit` (max 5,000) and `offset` (max 10,000) page it, alongside `totalCount`, `truncated`, and `nextOffset`
- Consecutive requests are spaced 16 seconds automatically — CDC rejects anything sent less than 15 seconds after the prior response finished, measured across all five databases

---

### `cdc://datasets` <sub>resource</sub>

- Top 50 CDC catalog entries by popularity, each carrying `assetType` and `columnCount` for orientation
- `columnCount: 0` marks a non-tabular entry (chart, map, story, file, or href); use `cdc_discover_datasets` for full catalog search with filtering and pagination

---

### `cdc://datasets/{datasetId}` <sub>resource</sub>

- Dataset metadata plus the first 100 columns as `application/json`; `datasetId` is a four-by-four identifier from `cdc_discover_datasets`
- Carries the dataset's total `columnCount` and a `truncated` flag; wider schemas continue via `cdc_get_dataset_schema` with `column_offset`
- Takes no query-parameter selector — an RFC 6570 `{?column_limit,column_offset}` template would stop the bare `cdc://datasets/{datasetId}` form from matching at all

---

### `analyze_health_trend` <sub>prompt</sub>

- Arguments: `topic` required; `timeRange` and `geography` optional
- Returns one user message that routes the question to CDC WONDER (national mortality, 1999–current, ICD-10-filterable) or the Socrata catalog (everything else), then walks discover → inspect → baseline query → compare → synthesize
- Routing is prose for the reader to act on — the handler does not classify the topic itself

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CDC-specific:

- Wraps the [Socrata SODA API v2.1](https://dev.socrata.com/) (the CDC Open Data portal, ~1,080 datasets) — no auth required, optional app token for higher rate limits
- Adds CDC WONDER mortality access (`cdc_query_wonder`) — a separate XML-over-HTTP CDC system, spanning five mortality databases from 1999 through the current year
- Discovery-first workflow for a heterogeneous catalog — discover, inspect schema, then query
- Two Socrata hosts via the `domain` input (`data.cdc.gov`, `chronicdata.cdc.gov`), allowlisted at the schema level — both front one tenant, so assets like PLACES and the Heart Disease & Stroke Atlas are reachable from either
- Conservative request spacing for both APIs — no rate-limit headers from Socrata, and CDC WONDER requests are spaced 16 seconds apart automatically

Agent-friendly output:

- Pagination and truncation disclosed on every tool — `totalCount`/`truncated`/`nextOffset` (or `shown`/`cap`) rather than a bare row count, so an agent can tell a complete result from a page of one
- Typed error contracts with a `recovery` hint on every declared reason (e.g. `not_queryable`, `page_out_of_range`) — actionable next steps, not just an error code
- Upstream data gaps stay visible rather than silently dropped — CDC's status tokens (`Suppressed`, `Unreliable`, `Not Applicable`) are named per cell in `cellNotes`, and hidden-row notices surface in `messages`
- `effectiveQuery` echoes the exact query sent (SoQL clauses or a WONDER summary), so a result is reproducible and a clause can be copied back into its parameter

## Getting started

### Public Hosted Instance

A public instance is available at `https://cdc.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "cdc-health-mcp-server": {
      "type": "streamable-http",
      "url": "https://cdc.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "cdc-health-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/cdc-health-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "cdc-health-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/cdc-health-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "cdc-health-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cdc-health-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher.
- Optional: [Socrata app token](https://dev.socrata.com/docs/app-tokens.html) for higher rate limits.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/cdc-health-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd cdc-health-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set optional overrides
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_SESSION_MODE` | HTTP session posture: `stateful`, `stateless`, or `auto`. `src/index.ts` declares `stateless`; this variable overrides it | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `CDC_APP_TOKEN` | Socrata app token for higher rate limits | — |
| `CDC_BASE_URL` | SODA host for requests that name no `domain` — in practice only the `cdc://datasets/{datasetId}` resource. The three Socrata tools always send a `domain` (`data.cdc.gov` by default), which overrides this | `https://data.cdc.gov` |
| `CDC_CATALOG_URL` | Base URL for Socrata Discovery API | `https://api.us.socrata.com/api/catalog/v1` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs) | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker build -t cdc-health-mcp-server .
docker run --rm -p 3010:3010 cdc-health-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/cdc-health-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Four CDC data tools. |
| `src/mcp-server/resources` | Resource definitions. Catalog overview and dataset detail. |
| `src/mcp-server/prompts` | Prompt definitions. Health trend analysis workflow. |
| `src/services/socrata` | Socrata SODA API service layer — HTTP client, catalog search, metadata, queries. |
| `src/services/wonder` | CDC WONDER service layer — XML request builder and response parser. |
| `src/utils` | Shared helpers, including `escapeTableCell` for `format()` output. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
