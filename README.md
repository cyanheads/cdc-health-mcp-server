<div align="center">
  <h1>@cyanheads/cdc-health-mcp-server</h1>
  <p><b>Search and query CDC public health data — mortality, vaccinations, surveillance, behavioral risk (Socrata SODA API) via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cdc-health-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cdc-health-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cdc-health-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cdc-health-mcp-server/releases/latest/download/cdc-health-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cdc-health-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2RjLWhlYWx0aC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cdc-health-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcdc-health-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cdc.caseyjhand.com/mcp](https://cdc.caseyjhand.com/mcp)

</div>

---

## Overview

CDC public health data from two systems: the Socrata-based CDC Open Data portal and CDC WONDER, a separate CDC system for national mortality statistics. Search the catalog, inspect dataset schemas, and run SoQL queries across vaccination, surveillance, and behavioral-risk data, or query WONDER for deaths, population, and death rates by year, age, sex, and race. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

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

- `query`, `category`, and `tags` filters (tags union, the other two intersect with them); up to 100 results per page (default 10), with `offset + limit` capped at 10,000 (`page_out_of_range` past it); `order` is `dataset_id` (default, stable paging) or `relevance`
- Results carry `assetType`, `columnCount` (0 marks a chart, map, story, file, or link that yields no data), an 8-name `columnSample`, and a description cut to 300 characters; enrichment adds `totalCount` and `appliedFilters`
- When a `category` or `tags` value matches nothing, the `notice` names the closest catalog values with their entry counts, e.g. `Vaccination` → `"Vaccinations" (89 datasets)`

---

### `cdc_get_dataset_schema` <sub>tool</sub>

- Four-by-four `datasetId` (e.g. `bi63-dtpu`); `column_limit` (default 100, max 500) and `column_offset` page wide schemas, reporting `totalCount`, `truncated`, and `nextOffset`
- Columns carry `fieldName`, `dataType`, and `description`; `rowCountSource` says whether `rowCount` is a `live` count or Socrata's `cached` figure, which can lag an active dataset. A non-tabular asset fails with `not_queryable`

---

### `cdc_list_catalog_vocabulary` <sub>tool</sub>

- All 55 categories come back whole; the ~1,600 tags are ranked by entry count and paged with `tag_limit` (default 50, max 500) and `tag_offset`. `filter` (3+ characters) narrows both by word containment in either direction, not fuzzy matching
- Each value carries `datasetCount`; enrichment reports `vocabularySize`, `categoryCount`, `tagCount`, `truncated`, and `nextOffset`, with `truncationCeiling` bounding the count of every omitted tag

---

### `cdc_query_dataset` <sub>tool</sub>

- `select`, `where`, `group`, `having`, `order`, and full-text `search`; up to 5,000 rows per call (default 100), `offset` up to 1,000,000. Pair offset paging with an `order` (`:id` works on any dataset)
- `effectiveQuery` echoes the SoQL clauses as sent, unencoded; `truncated` and `nextOffset` come from a one-row over-fetch, with no `totalCount`. A chart or map ID fails with `not_queryable`

---

### `cdc_query_wonder` <sub>tool</sub>

| `database` | CDC database | Years | Race groups | `mcd_icd10` |
|:---|:---|:---|:---|:---|
| `underlying_1999_2020` *(default)* | D76 — Underlying Cause of Death | 1999–2020 | 4 bridged | — |
| `provisional` | D176 — Provisional Mortality Statistics | 2018 → current year | 6 single-race | yes |
| `underlying_2018_2024` | D158 — Underlying Cause of Death, Single Race | 2018–2024 | 6 single-race | — |
| `multiple_1999_2020` | D77 — Multiple Cause of Death | 1999–2020 | 4 bridged | yes |
| `multiple_2018_2024` | D157 — Multiple Cause of Death, Single Race | 2018–2024 | 6 single-race | yes |

- `group_by` takes 1–4 of `year`, `age_group`, `sex`, `race`, national only. `cause_icd10` and `mcd_icd10` take an ICD-10 code, a chapter or block range (`X40-X49`), or a list of up to 50 matched as one union; `limit` (max 5,000) and `offset` (max 10,000) page the table
- Rows carry `deaths`, `population`, `crude_rate`, and `age_adjusted_rate` where age can be standardized. Cells CDC returns as `Suppressed`, `Unreliable`, or `Not Applicable` read `null` and are listed in `cellNotes`; `messages` reports whole rows CDC hid, and `totalCount` is exact
- CDC rejects requests less than 15 seconds apart, so calls are spaced 16 seconds apart and queued one at a time

---

### `cdc://datasets` <sub>resource</sub>

- Top 50 catalog entries by popularity, each with `id`, `name`, `assetType`, `category`, `columnCount`, and `updatedAt`, plus the catalog `totalCount`
- `columnCount: 0` marks a non-tabular entry; `cdc_discover_datasets` searches and pages the full catalog

---

### `cdc://datasets/{datasetId}` <sub>resource</sub>

- Dataset metadata plus the first 100 columns as `application/json`, with `columnCount` and `truncated`
- Takes no window selector; continue a wider schema with `cdc_get_dataset_schema` and `column_offset`

---

### `analyze_health_trend` <sub>prompt</sub>

- Arguments: `topic` required; `timeRange` and `geography` optional
- Returns one user message that routes the question to `cdc_query_wonder` (national mortality) or the Socrata tools (everything else), then walks discover → inspect → baseline → compare → synthesize

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CDC-specific:

- The [Socrata SODA API v2.1](https://dev.socrata.com/) over the CDC Open Data portal (~1,080 datasets); no auth required, and an optional app token raises rate limits
- CDC WONDER mortality data from five databases covering 1999 through the current year, reached over its XML request API
- The three Socrata tools take a `domain` input, allowlisted to `data.cdc.gov` (default) and `chronicdata.cdc.gov`. Both front the same catalog, so it picks the host that answers, not the datasets you can reach
- `category` and `tags` match the catalog's controlled vocabularies (categories case-sensitively, tags case-insensitively), so a near miss returns nothing; `cdc_list_catalog_vocabulary` lists the real values
- Socrata returns every value as a string, and a column like `year` is numeric in some datasets and text in others. Match WHERE literals to the column's `dataType` from the schema: numbers bare, strings single-quoted

Agent-friendly output:

- Paging disclosed rather than implied: `totalCount`, `truncated`, `nextOffset`, and `shown`/`cap`. Both query tools bound each page by a 200,000-character budget over `structuredContent` and `content[]` together, so a wide page can end short of `limit`
- Typed error contracts with a recovery hint on every declared reason, such as `not_queryable`, `page_out_of_range`, and `invalid_query`
- Upstream gaps stay visible: WONDER status tokens per cell in `cellNotes`, hidden-row notices in `messages`, and `rowCountSource` on schema row counts
- `effectiveQuery` echoes the SoQL clauses or a WONDER query summary, so a result can be reproduced

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a [Socrata app token](https://dev.socrata.com/docs/app-tokens.html) for higher rate limits.

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
# optionally set CDC_APP_TOKEN
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `CDC_APP_TOKEN` | Socrata app token; raises rate limits. | none |
| `CDC_BASE_URL` | SODA host for requests that name no `domain`, in practice only the `cdc://datasets/{datasetId}` resource. The Socrata tools choose their host with `domain`. | `https://data.cdc.gov` |
| `CDC_CATALOG_URL` | Socrata Discovery API base URL. | `https://api.us.socrata.com/api/catalog/v1` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/cdc-health-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Four Socrata tools and one WONDER tool. |
| `src/mcp-server/resources` | Resource definitions. Catalog overview and dataset detail. |
| `src/mcp-server/prompts` | Prompt definitions. Health trend analysis workflow. |
| `src/services/socrata` | Socrata service — catalog search, vocabularies, metadata, SoQL queries. |
| `src/services/wonder` | CDC WONDER service — XML request builder, response parser, request spacing. |
| `src/utils` | Shared helpers — HTML-to-text, table-cell escaping, vocabulary matching, response budget. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
