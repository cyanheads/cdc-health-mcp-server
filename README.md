<div align="center">
  <h1>@cyanheads/cdc-health-mcp-server</h1>
  <p><b>MCP server for the CDC Open Data portal. Search ~1,487 public health datasets, inspect schemas, and execute SoQL queries across disease surveillance, mortality, vaccinations, behavioral risk, and more. STDIO or Streamable HTTP.</b>
  <div>3 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/cdc-health-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cdc-health-mcp-server) [![Version](https://img.shields.io/badge/Version-0.4.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://cdc.caseyjhand.com/mcp](https://cdc.caseyjhand.com/mcp)

</div>

---

## Tools

Three tools for discovering and querying CDC public health data:

| Tool | Description |
|:---|:---|
| `cdc_discover_datasets` | Search the catalog by keyword, category, or tag. Entry point for all queries. |
| `cdc_get_dataset_schema` | Fetch column schema, row count, and metadata for a dataset. Essential before writing SoQL queries. |
| `cdc_query_dataset` | Execute SoQL queries — filter, aggregate, sort, full-text search, and field selection. |

### `cdc_discover_datasets`

Search the CDC dataset catalog to find relevant datasets.

- Full-text search across dataset names and descriptions
- Filter by domain category (e.g., "NNDSS", "Vaccinations", "Behavioral Risk Factors")
- Filter by domain tags (e.g., `["covid19", "surveillance"]`)
- Returns dataset IDs, names, descriptions, column lists, and update timestamps
- Pagination via offset for browsing large result sets

---

### `cdc_get_dataset_schema`

Fetch the full column schema for a specific dataset.

- Column names, data types, and descriptions
- Row count and last-updated timestamp
- Essential for understanding column types before writing `$where` clauses
- Accepts four-by-four dataset identifiers (e.g., `bi63-dtpu`)

---

### `cdc_query_dataset`

Execute SoQL queries against any CDC dataset.

- Full SoQL support: `$select`, `$where`, `$group`, `$having`, `$order`
- Full-text search across all text columns via `$q`
- Up to 5,000 rows per request with pagination
- Returns the assembled SoQL query string for debugging
- All response values are strings (per SODA v2.1) — parse based on column type metadata

## Resources and prompt

| Type | Name | Description |
|:---|:---|:---|
| Resource | `cdc://datasets` | Top 50 datasets by popularity for orientation |
| Resource | `cdc://datasets/{datasetId}` | Dataset metadata and column schema (equivalent to schema tool) |
| Prompt | `analyze_health_trend` | Guided 5-step workflow: discover, inspect, baseline query, compare, synthesize |

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
- Discovery-first approach for a heterogeneous catalog (~1,487 datasets across many health domains)
- Conservative request spacing for rate limit compliance (no rate-limit headers returned by Socrata)
- Handles SODA string-typed responses — all values returned as strings, parsed via column type metadata

## Getting started

### Public Hosted Instance

A public instance is available at `https://cdc.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "cdc-health": {
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
    "cdc-health": {
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
    "cdc-health": {
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
    "cdc-health": {
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

- [Bun v1.3.2](https://bun.sh/) or higher.
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
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

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
