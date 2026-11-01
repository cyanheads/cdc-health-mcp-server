<div align="center">
  <h1>@cyanheads/cdc-health-mcp-server</h1>
  <p><b>Search and query CDC public health data — mortality, vaccinations, surveillance, behavioral risk (Socrata SODA API) via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.11.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cdc-health-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cdc-health-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cdc-health-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

CDC public health data from the CDC Open Data portal and CDC WONDER. Search 1,000+ datasets on vaccination, surveillance, and behavioral risk, inspect their schemas and query them with SoQL, or pull national mortality statistics by year, month, age, sex, race, Hispanic origin, or cause of death.

### Tools

| Tool | Description |
|:---|:---|
| `cdc_discover_datasets` | Search the CDC dataset catalog by keyword, category, tag, or asset type |
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

### Skill

| Skill | Description |
|:---|:---|
| `cdc-health-guide` | Gates for agents comparing or trending results: which WONDER rate to compare across groups, race beside Hispanic origin, the provisional database's partial year and withheld causes, finding a peak month, splicing WONDER databases, and reading stratified Socrata tables |

Ships in `skills/` for plugin installs, the npm package, the Docker image, and the `.mcpb` bundle, and is served over MCP as `skill://cdc-health-guide/SKILL.md`.

## Capability reference

### `cdc_discover_datasets` <sub>tool</sub>

- Filters: `query`, `category`, `tags`, and `asset_types` (`dataset`, `filter`, `chart`, `map`, `story`, `file`, `href`; `["dataset", "filter"]` keeps the entries with rows to query). `tags` union — a dataset matches when it carries any one of them, so each tag added widens the result set — while `query`, `category`, and `asset_types` intersect with them. `limit` defaults to 10; `offset + limit` is capped at 10,000 (`page_out_of_range` past it). `order` defaults to `relevance` when `query` is set and `dataset_id` otherwise; relevance order varies between calls, so only `dataset_id` pages every match exactly once
- Results carry `assetType`, `permalink`, `columnCount` (0 marks a chart, map, or other non-tabular asset), an 8-name `columnSample`, and a description cut to 300 characters, plus `totalCount` and `appliedFilters`. A link (`href`) entry's destinations are in `accessPoints`, and the datasets a chart, map, filter, or story is built on in `parentIds`
- When a `category` or `tags` value matches nothing, the `notice` names the closest catalog values with their entry counts, e.g. `Vaccination` → `"Vaccinations" (89 datasets)`

---

### `cdc_get_dataset_schema` <sub>tool</sub>

- Takes a four-by-four `datasetId` (e.g. `bi63-dtpu`). `column_limit` (default 100) and `column_offset` page wide schemas, reporting `totalCount`, `truncated`, and `nextOffset`
- The dataset `description` is capped at 4,000 characters by default (`descriptionTruncated` and `descriptionLength` are set when cut); `full_description: true` returns the whole text
- Columns carry `fieldName`, `dataType`, and `description`. `rowCountSource` says whether `rowCount` is `live` or Socrata's `cached` figure
- Where the publisher recorded them, `temporalCoverage`, `updateFrequency`, `geographicCoverage`, `citation`, `license`, and `attribution` come back as the publisher's own text, and a filter carries `parentId`, the dataset it is a view of
- A chart or map fails with `not_queryable`, naming the dataset it is built on

---

### `cdc_list_catalog_vocabulary` <sub>tool</sub>

- Every category comes back whole; the ~1,600 tags are ranked by entry count and paged with `tag_limit` (default 50) and `tag_offset`. `filter` (up to 500 characters) narrows both by word match, not fuzzy matching; a word under 3 letters or digits matches whole words only
- Each value carries `datasetCount`; the response also reports `vocabularySize`, `categoryCount`, `tagCount`, `truncated`, `nextOffset`, and `truncationCeiling` (an upper bound on the counts of the tags after the page)

---

### `cdc_query_dataset` <sub>tool</sub>

- Clauses: `select`, `where`, `group`, `having`, `order`, and full-text `search`. Up to 1,000 rows per call (default 100; a larger `limit` is clamped, and the notice names the clamp when rows remain), `offset` up to 1,000,000
- For stable offset paging, set an `order` ending in a unique tie-breaker (`:id` on ungrouped rows, the grouped columns on a grouped query); the notice says so when it is missing
- `effectiveQuery` echoes the SoQL clauses as sent; `truncated` and `nextOffset` report paging, with no `totalCount`. A chart or map ID fails with `not_queryable`, naming the dataset it is built on

---

### `cdc_query_wonder` <sub>tool</sub>

| `database` | CDC database | Years | Race groups | `mcd_icd10` |
|:---|:---|:---|:---|:---|
| `underlying_1999_2020` *(default)* | D76 — Underlying Cause of Death | 1999–2020 | 4 bridged | — |
| `provisional` | D176 — Provisional Mortality Statistics | 2018 → current year (latest year partial) | 6 single-race | yes |
| `underlying_2018_2024` | D158 — Underlying Cause of Death, Single Race | 2018–2024 | 6 single-race | — |
| `multiple_1999_2020` | D77 — Multiple Cause of Death | 1999–2020 | 4 bridged | yes |
| `multiple_2018_2024` | D157 — Multiple Cause of Death, Single Race | 2018–2024 | 6 single-race | yes |

- `group_by` takes 1–4 of `year`, `month`, `age_group`, `sex`, `race`, `hispanic_origin`, `icd_chapter`, `icd_subchapter`, `cause_113`, `leading_causes` (alone only), and `injury_intent`; results are always national. A grouping that could produce more than 10,000 rows is refused before any request. `cause_icd10` and `mcd_icd10` take an ICD-10 code, a range (`X40-X49`), or a list of up to 50. `age_groups` takes `NS` (age not stated) alone or with all eleven known groups. `race` reports four bridged groups on the 1999–2020 databases and six single-race groups on the rest; the two families' series are not comparable
- `limit` pages the table fetched from CDC; omitted, it returns the rest of the table from `offset`, up to 10,000 rows per call. A larger `limit` is lowered to that ceiling, which equals the table-size bound, so one call always holds the whole table. `offset` goes up to 10,000
- Rows carry `deaths`, `population`, `crude_rate`, and `age_adjusted_rate` where age can be standardized, each rate followed by its 95% confidence interval (`crude_rate_lower` and `crude_rate_upper`, `age_adjusted_rate_lower` and `age_adjusted_rate_upper`), `null` where CDC sent none. Chapter and sub-chapter rows add `cause_code`, the ICD-10 range `cause_icd10` takes; `cause_113` rows add `cause_level`; `month` rows carry deaths only. Cells CDC returns as `Suppressed`, `Unreliable`, or `Not Applicable` read `null` and are listed in `cellNotes`; `messages` reports rows CDC hid, and `totalCount` is exact
- The `provisional` database's latest year covers part of the year against a full-year population, and CDC withholds some recent causes; a `notice` says so whenever a query reaches either, and on a `month` grouping names the month the data ends in as partial
- CDC rejects requests less than 15 seconds apart, so calls are queued one at a time and spaced 16 seconds apart. A request WONDER has not finished answering within 20 seconds fails as a retryable `upstream_error`

---

### `cdc://datasets` <sub>resource</sub>

- Top 50 catalog entries by popularity, each with `id`, `name`, `assetType`, `category`, `columnCount`, and `updatedAt`, plus the catalog `totalCount`
- `columnCount: 0` marks a non-tabular entry; `cdc_discover_datasets` searches and pages the full catalog

---

### `cdc://datasets/{datasetId}` <sub>resource</sub>

- Dataset metadata plus the first 100 columns as `application/json`, with `columnCount` and `truncated`; the description is capped at 4,000 characters. It carries the same `parentId` and publisher fields as `cdc_get_dataset_schema`, and a chart or map fails with `not_queryable`, naming its parent dataset
- For more columns or the full description, use `cdc_get_dataset_schema` with `column_offset` or `full_description: true`

---

### `analyze_health_trend` <sub>prompt</sub>

- Arguments: `topic` required; `timeRange` and `geography` optional
- Returns one user message that routes the question to `cdc_query_wonder` (national mortality) or the Socrata tools (everything else), then walks discover → inspect → baseline → compare → synthesize

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CDC-specific:

- The [Socrata SODA API v2.1](https://dev.socrata.com/) over the CDC Open Data portal (~1,080 datasets); no auth required, and an optional app token raises rate limits
- CDC WONDER mortality data from five databases covering 1999 through the current year, reached over its XML request API
- The four Socrata tools take a `domain` input, limited to `data.cdc.gov` (default) and `chronicdata.cdc.gov`; both serve the same catalog
- `category` and `tags` must match the catalog's own values (matched ignoring case, otherwise exactly); `cdc_list_catalog_vocabulary` lists them
- Socrata returns values as strings (geo columns as GeoJSON objects), and a column like `year` is numeric in some datasets and text in others. Match WHERE literals to the column's `dataType`: numbers bare, strings single-quoted

Agent-friendly output:

- Paging is reported explicitly: `totalCount`, `truncated`, `nextOffset`, and `shown`/`cap`. `limit` sets the page: `cdc_query_dataset` clamps it to 1,000 rows, naming the clamp in the `notice` when rows remain, and `cdc_query_wonder` lowers it to 10,000, its table-size bound; up to those ceilings a page ends short of `limit` only at the end of the result set
- Typed errors with a recovery hint on every declared reason, such as `not_queryable`, `page_out_of_range`, and `invalid_query`
- Upstream gaps stay visible: WONDER status tokens in `cellNotes`, hidden-row notices in `messages`, and `rowCountSource` on schema row counts
- `effectiveQuery` echoes the SoQL clauses or a WONDER query summary, so a result can be reproduced

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http cdc-health-mcp-server https://cdc.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add cdc-health-mcp-server -- npx -y @cyanheads/cdc-health-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "cdc-health-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/cdc-health-mcp-server"]
    }
  }
}
```

Setting `CDC_APP_TOKEN` to a [Socrata app token](https://dev.socrata.com/docs/app-tokens.html) raises the Socrata rate limits. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `CDC_APP_TOKEN` | Socrata app token; raises rate limits. | none |
| `CDC_BASE_URL` | SODA host for requests with no `domain` (the `cdc://datasets/{datasetId}` resource). | `https://data.cdc.gov` |
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

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/cdc-health-mcp-server.git
  cd cdc-health-mcp-server && bun install
  cp .env.example .env   # optionally set CDC_APP_TOKEN
  ```

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
docker run --rm -p 3010:3010 ghcr.io/cyanheads/cdc-health-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/cdc-health-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cdc-health-mcp-server:latest"]`. To build locally, `docker build -t cdc-health-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
| `src/utils` | Shared helpers — HTML-to-text, table-cell escaping, vocabulary matching. |
| `skills/cdc-health-guide` | Agent skill published to agents that install the server, and served over MCP as `skill://cdc-health-guide/SKILL.md`. |
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
