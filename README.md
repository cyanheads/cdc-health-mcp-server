<div align="center">
  <h1>@cyanheads/cdc-health-mcp-server</h1>
  <p><b>Search and query CDC public health data — mortality, vaccinations, surveillance, behavioral risk (Socrata SODA API) via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cdc-health-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cdc-health-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cdc-health-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cdc-health-mcp-server/releases/latest/download/cdc-health-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cdc-health-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2RjLWhlYWx0aC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cdc-health-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/cdc-health-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cdc.caseyjhand.com/mcp](https://cdc.caseyjhand.com/mcp)

</div>

---

## Tools

Four tools for discovering and querying CDC public health data. Three query the CDC Open Data portal (Socrata); one queries CDC WONDER mortality statistics:

| Tool | Description |
|:---|:---|
| `cdc_discover_datasets` | Search the catalog by keyword, category, or tag. Entry point for all queries. |
| `cdc_get_dataset_schema` | Fetch column schema, row count, and metadata for a dataset. Essential before writing SoQL queries. Returns a bounded column window with a continuation offset for wide schemas. |
| `cdc_query_dataset` | Execute SoQL queries — filter, aggregate, sort, full-text search, and field selection. |
| `cdc_query_wonder` | Query CDC WONDER for national mortality statistics (deaths, population, crude/age-adjusted rates) by year, age, sex, and race, filtered by ICD-10 cause. Covers five CDC mortality databases — final and provisional, underlying-cause and multiple-cause. Large tables page with a continuation offset. |

### `cdc_discover_datasets`

Search the CDC dataset catalog to find relevant datasets.

- Full-text search across dataset names and descriptions
- Filter by domain category (e.g., "NNDSS", "Vaccinations", "Behavioral Risk Factors")
- Filter by domain tags (e.g., `["covid19", "surveillance"]`) — a dataset matches on any one tag, so each tag added widens the result set; narrow with `query` or `category`, which intersect with the tag set
- Returns dataset IDs, names, truncated descriptions, a column count with a short column sample, and update timestamps — use `cdc_get_dataset_schema` for the full column list
- Each result carries its catalog `assetType` (`dataset`, `filter`, `chart`, `map`, `story`, `file`, `href`); a `columnCount` of 0 marks an entry that is not tabular and yields no data from the other tools
- Pagination via offset for browsing large result sets — `offset` plus `limit` must not exceed 10,000, the ceiling the catalog enforces
- `domain` selects the host contacted, `data.cdc.gov` (default) or `chronicdata.cdc.gov` — both front the same catalog and return the same entries, so switching hosts neither widens nor narrows a search

---

### `cdc_get_dataset_schema`

Fetch the column schema for a specific dataset.

- Column names, data types, and full descriptions — never truncated per column
- Row count and last-updated timestamp
- Essential for understanding column types before writing `$where` clauses
- Accepts four-by-four dataset identifiers (e.g., `bi63-dtpu`)
- Returns the first 100 columns by default. Catalog schemas run from 3 to 322 columns, so every ordinary dataset arrives whole; wider ones report `totalCount`, `truncated`, and a `nextOffset` to pass back as `column_offset`. Raise `column_limit` (max 500) to pull a wide schema in one call
- A `column_offset` at or past the column count returns an empty window rather than an error
- Fails with `not_queryable` when the ID names a non-tabular catalog asset, rather than returning an empty column list
- `domain` selects the host contacted, `data.cdc.gov` (default) or `chronicdata.cdc.gov` — a four-by-four ID resolves on either

---

### `cdc_query_dataset`

Execute SoQL queries against any CDC dataset.

- Full SoQL support: `$select`, `$where`, `$group`, `$having`, `$order`
- Full-text search across all text columns via `$q`
- Up to 5,000 rows per request with pagination
- `truncated` is measured, not guessed: the request fetches one row past the limit and drops it, so a page that fills the limit exactly is reported as complete instead of sending you paginating an aggregate
- `nextOffset` names where to resume whenever rows remain. Pair it with an `order` clause — SODA does not order results implicitly, and `order=":id"` works on any dataset
- Rows are also bounded by a 200,000-character response budget, so a wide dataset at `limit: 5000` returns a usable page with a `nextOffset` rather than several megabytes
- Returns the SoQL clauses it sent as `effectiveQuery`, values in their original text rather than URL-encoded, so a clause can be copied back into the parameter it came from
- All response values are strings (per SODA v2.1) — parse based on column type metadata
- `domain` selects the host contacted, `data.cdc.gov` (default) or `chronicdata.cdc.gov` — a four-by-four ID returns the same rows from either

---

### `cdc_query_wonder`

Query CDC WONDER for national US mortality statistics — a separate CDC system from the Socrata datasets the other tools query.

`database` picks which of CDC's five mortality databases answers the query:

| Value | CDC database | Years | Race groups | `mcd_icd10` |
|:---|:---|:---|:---|:---|
| `underlying_1999_2020` *(default)* | D76 — Underlying Cause of Death | 1999–2020 | 4 bridged | — |
| `provisional` | D176 — Provisional Mortality Statistics | 2018 → current year | 6 single-race | yes |
| `underlying_2018_2024` | D158 — Underlying Cause of Death, Single Race | 2018–2024 | 6 single-race | — |
| `multiple_1999_2020` | D77 — Multiple Cause of Death | 1999–2020 | 4 bridged | yes |
| `multiple_2018_2024` | D157 — Multiple Cause of Death, Single Race | 2018–2024 | 6 single-race | yes |

- Group results by any of `year`, `age_group`, `sex`, `race` (1–4 dimensions)
- Filter by ICD-10 underlying cause, sex, age groups, and year range
- `age_groups` carries the whole list CDC offers: the eleven ten-year groups plus `NS`, the group for a death whose age was not recorded. Listing the eleven without `NS` returns fewer deaths than the same query unfiltered, so include it to match an all-ages total or select it alone to count those deaths
- `mcd_icd10` matches a cause recorded anywhere on the death certificate rather than only the one certified as underlying — "died with a respiratory condition listed", which no underlying-cause query can produce. Accepted only by the three databases marked above; the others reject it. A multiple-cause database queried without it returns the same figures as the underlying-cause database for the same years, and says so
- `year_range` carries the union of every database's span; a range outside the span of the one selected is rejected with that database's actual years named
- A `race` breakdown does not carry across the two race families — bridged race combines Asian and Pacific Islander into one group, single race splits them and adds a multiracial category, so the two series are not comparable
- Both cause filters also take `999--999`, CDC's marker for deaths whose cause it is still withholding under the provisional database's six-month reporting lag. Only `provisional` records them; the other databases reject the code, and the tool says which one to select
- Row dimension values are CDC's own labels with surrounding whitespace removed, so the same year keys identically across databases — CDC pads a few of them, and `"2024 "` and `"2024"` would otherwise read as two different years
- Provisional rows carry CDC's own year labels, e.g. `2025 (provisional)` and `2026 (provisional and partial)`, rather than a bare year
- Returns deaths, population, and crude death rate, plus age-adjusted rate when WONDER can standardize by age — omitted when grouping by `age_group` or filtering to a single age group
- Returns the whole table by default. A broad grouping runs long — `["year","age_group","sex","race"]` can pass a thousand rows — so `limit` (max 5,000) and `offset` take it a page at a time, alongside `totalCount`, `truncated`, and a `nextOffset` to resume from. An `offset` at or past the row total returns an empty page rather than an error
- Paging shapes the response only: WONDER's request carries no limit of its own, so CDC is asked once either way and every page is a slice of the one table. `caveats` and `messages` come back complete on each page; `cellNotes` covers the rows returned, with `row` relative to them
- National totals only — sub-national (state/county) breakdowns are not available through the WONDER API (CDC vital-statistics policy)
- CDC replaces some measure values with a status token — `Suppressed` (withheld for confidentiality), `Unreliable` (a rate from fewer than 20 deaths), `Not Applicable` (no population denominator). Those cells read `null` in `rows`; `cellNotes` names the row, column, and token for each
- CDC also hides whole rows before sending the table — strata with zero deaths, and strata whose death count is suppressed. Those rows are absent from `rows` with nothing marking the gap, so `messages` carries CDC's own statement whenever it happened
- CDC rejects requests made less than 15 seconds apart, measured from the end of the previous response and counted across all five databases; the server spaces consecutive requests 16 seconds automatically

## Resources and prompt

| Type | Name | Description |
|:---|:---|:---|
| Resource | `cdc://datasets` | 50 most-viewed catalog entries for orientation, each with its asset type and column count |
| Resource | `cdc://datasets/{datasetId}` | Dataset metadata plus the first 100 columns, with the dataset's total column count and a truncation flag; `cdc_get_dataset_schema` reaches the rest |
| Prompt | `analyze_health_trend` | Picks between CDC WONDER and the Socrata catalog for the question at hand, then runs a 5-step workflow: discover, inspect, baseline query, compare, synthesize |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

CDC-specific:

- Wraps the [Socrata SODA API v2.1](https://dev.socrata.com/) — no auth required, optional app token for higher rate limits
- Adds CDC WONDER mortality access (`cdc_query_wonder`) — national deaths, population, and crude/age-adjusted rates across five mortality databases spanning 1999 through the current year, final and provisional, underlying-cause and multiple-cause; a separate XML-over-HTTP CDC system
- Discovery-first approach for a heterogeneous catalog (~1,080 datasets across many health domains)
- Two CDC Socrata hosts via the `domain` input — [`data.cdc.gov`](https://data.cdc.gov/) (default) and [`chronicdata.cdc.gov`](https://chronicdata.cdc.gov/), restricted to this allowlist. Both front one Socrata tenant: a single catalog whose assets — PLACES small-area estimates, the Heart Disease & Stroke Atlas and Environmental Public Health Tracking among them — are discoverable and queryable from either host
- Conservative request spacing for rate limit compliance (no rate-limit headers returned by Socrata)
- Handles SODA string-typed responses — all values returned as strings, parsed via column type metadata

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

- [Bun v1.3.0](https://bun.sh/) or higher.
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

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `CDC_APP_TOKEN` | Socrata app token for higher rate limits | none |
| `CDC_BASE_URL` | Base URL for SODA API requests | `https://data.cdc.gov` |
| `CDC_CATALOG_URL` | Base URL for Socrata Discovery API | `https://api.us.socrata.com/api/catalog/v1` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs) | `false` |

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Three CDC data tools. |
| `src/mcp-server/resources` | Resource definitions. Catalog overview and dataset detail. |
| `src/mcp-server/prompts` | Prompt definitions. Health trend analysis workflow. |
| `src/services/socrata` | Socrata SODA API service layer — HTTP client, catalog search, metadata, queries. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
