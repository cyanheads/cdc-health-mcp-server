# CDC Health Statistics MCP Server

[![npm version](https://img.shields.io/npm/v/@cyanheads/cdc-health-mcp-server.svg)](https://www.npmjs.com/package/@cyanheads/cdc-health-mcp-server)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

MCP server for discovering and querying CDC public health datasets via the [Socrata SODA API](https://dev.socrata.com/). Wraps the [CDC Open Data portal](https://data.cdc.gov/) (~1,487 datasets) covering disease surveillance, mortality, behavioral risk factors, vaccinations, environmental health, and more.

No authentication required. Optional app token for higher rate limits.

Built on [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core).

## Features

| Definition | Type | Description |
|:-----------|:-----|:------------|
| `cdc_discover_datasets` | Tool | Search the catalog by keyword, category, or tag |
| `cdc_get_dataset_schema` | Tool | Fetch column schema, row count, and metadata for a dataset |
| `cdc_query_dataset` | Tool | Execute SoQL queries — filter, aggregate, sort, full-text search |
| `cdc://datasets` | Resource | Paginated dataset catalog listing |
| `cdc://datasets/{datasetId}` | Resource | Individual dataset metadata and schema |
| `analyze_health_trend` | Prompt | Guided workflow: discover, inspect, query, compare, synthesize |

## Quickstart

### Prerequisites

- [Node.js](https://nodejs.org/) >= 22.0.0
- [Bun](https://bun.sh/) (for development)

### Install

```bash
bun install
bun run build
```

### Configure

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "cdc-health": {
      "command": "node",
      "args": ["/path/to/cdc-health-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio"
      }
    }
  }
}
```

Or via npx:

```json
{
  "mcpServers": {
    "cdc-health": {
      "command": "npx",
      "args": ["-y", "@cyanheads/cdc-health-mcp-server", "run", "start:stdio"]
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|:---------|:---------|:--------|:------------|
| `CDC_APP_TOKEN` | No | — | Socrata app token for higher rate limits |
| `CDC_BASE_URL` | No | `https://data.cdc.gov` | Base URL for SODA API requests |
| `CDC_CATALOG_URL` | No | `https://api.us.socrata.com/api/catalog/v1` | Discovery API URL |
| `MCP_TRANSPORT_TYPE` | No | `stdio` | Transport: `stdio` or `http` |
| `MCP_LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |

## Usage

The core workflow is **discover, inspect, query**:

1. **Discover** — Search the catalog to find relevant datasets
2. **Inspect** — Check the schema to understand columns and types
3. **Query** — Execute SoQL queries against the data

Example conversation:

> **User:** What are the leading causes of death in the US?
>
> **Agent:** Uses `cdc_discover_datasets` with query "leading causes of death", finds dataset `bi63-dtpu`, inspects its schema, then queries for the latest year's data.

## Development

```bash
bun run dev:stdio     # Dev mode (stdio, hot reload)
bun run dev:http      # Dev mode (HTTP)
bun run test          # Run tests
bun run devcheck      # Lint + format + typecheck + audit
```

## License

[Apache-2.0](LICENSE)
