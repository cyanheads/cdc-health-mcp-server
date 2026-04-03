---
name: cdc-health-mcp-server
status: designed
priority: high
difficulty: medium
category: health
api_docs: https://dev.socrata.com/foundry/data.cdc.gov/
---

# CDC Health Statistics MCP Server

## Overview

Wraps the [CDC Open Data portal](https://data.cdc.gov/) (1,487 datasets) via the [Socrata SODA API](https://dev.socrata.com/) to enable discovery, exploration, and querying of public health data. Covers disease surveillance, mortality, behavioral risk factors, vaccinations, environmental health, injury statistics, and more. No authentication required -- app token optional for higher rate limits.

The core challenge: 1,487 datasets with heterogeneous schemas. The server provides a discovery-first workflow -- find the right dataset, inspect its schema, then query it -- rather than hard-coding knowledge of specific datasets.

**Dependencies**: `@cyanheads/mcp-ts-core`, Socrata SODA API v2.1 (public, optional app token). SODA3 (`/api/v3/views/{id}/query.json`) is available with mandatory auth but SODA 2.1 remains fully supported. Target SODA 2.1 for now -- no auth required for basic access.

---

## Tools

### `cdc_discover_datasets`

Search the CDC dataset catalog by keyword, category, or tag. Returns dataset IDs, names, descriptions, column lists, and update timestamps. This is the entry point -- use before querying to find the right dataset for a question.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Full-text search across dataset names and descriptions (e.g., "diabetes mortality", "lead exposure children"). |
| `category` | string | No | Filter by domain category. Common values: "National Center for Health Statistics", "NNDSS", "Vaccinations", "Public Health Surveillance", "Behavioral Risk Factors", "Motor Vehicle", "Maternal & Child Health". |
| `tags` | string[] | No | Filter by domain tags (e.g., ["covid19", "surveillance"]). |
| `limit` | number | No | Results to return (default 10, max 100). |
| `offset` | number | No | Pagination offset for browsing beyond first page. |

**Returns:** Array of `{ id, name, description, category, tags, columnNames, columnTypes, updatedAt, pageViews }`. Includes `totalCount` for pagination.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| Empty results | No datasets match query/category/tags combination | Broaden search terms, try fewer filters, or use `query` alone without `category`/`tags` |
| Rate limited (429) | Too many requests to Socrata Discovery API | Retry after brief delay. Consider using an app token for higher limits |
| Catalog API timeout | Discovery API occasionally slow under load | Retry once. Reduce `limit` if fetching large pages |

**Catalog API:** `GET https://api.us.socrata.com/api/catalog/v1?domains=data.cdc.gov`

---

### `cdc_get_dataset_schema`

Fetch the full column schema for a dataset -- names, data types, descriptions. Essential before writing queries against unfamiliar datasets. Also returns dataset name, description, row count, and last-updated timestamp.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | Yes | Four-by-four dataset identifier matching `[a-z0-9]{4}-[a-z0-9]{4}` (e.g., "bi63-dtpu"). Obtain from `cdc_discover_datasets`. |

**Returns:** `{ name, description, rowCount, updatedAt, columns: [{ fieldName, dataType, description }] }`.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| Invalid dataset ID format | ID doesn't match `[a-z0-9]{4}-[a-z0-9]{4}` | Check the ID from `cdc_discover_datasets` output -- IDs are always 9 characters like "bi63-dtpu" |
| Dataset not found (404) | Valid format but ID doesn't exist or was deleted | Search again with `cdc_discover_datasets` -- the dataset may have been replaced or retired |
| Rate limited (429) | Too many requests | Retry after brief delay |

**Metadata API:** `GET https://data.cdc.gov/api/views/{datasetId}.json`

---

### `cdc_query_dataset`

Execute a SoQL query against any CDC dataset. Supports filtering, aggregation, sorting, full-text search, and field selection. This is the workhorse -- once you know the dataset ID and column names, use this to extract data.

Accepts either a convenience `search` parameter for simple full-text queries, or individual SoQL clauses for full control. At least one of `search`, `where`, or `select` must be provided.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `datasetId` | string | Yes | Four-by-four dataset identifier matching `[a-z0-9]{4}-[a-z0-9]{4}`. |
| `search` | string | No | Convenience full-text search across all text columns (maps to `$q`). Use for exploratory queries. For precise filtering, use `where` instead. |
| `select` | string | No | SoQL SELECT clause. Column names, aliases, aggregates: `"state, sum(deaths) as total_deaths"`. Omit for all columns. |
| `where` | string | No | SoQL WHERE clause. Supports `=`, `!=`, `>`, `<`, `>=`, `<=`, `AND`, `OR`, `NOT`, `IS NULL`, `IS NOT NULL`, `LIKE`, `IN(...)`, `BETWEEN`, `starts_with()`, `contains()`. Strings must be single-quoted: `"state='California' AND year=2020"`. |
| `group` | string | No | SoQL GROUP BY clause. Requires aggregate functions in `select`. |
| `having` | string | No | SoQL HAVING clause. Filters aggregated results. |
| `order` | string | No | SoQL ORDER BY clause. Field name with optional `ASC`/`DESC`: `"total_deaths DESC"`. |
| `limit` | number | No | Max rows to return (default 1000, no hard ceiling -- but large limits mean large responses). Use with `offset` for pagination. |
| `offset` | number | No | Row offset for pagination. |

**Returns:** Array of row objects with requested fields. Includes `rowCount` (length of returned rows) and `query` (the assembled SoQL for debugging).

**Tip -- enumerating column values:** To see distinct values for a column (e.g., what states or years exist), use `select: "{column}, count(*) as count"`, `group: "{column}"`, `order: "count DESC"`. Add a `where` clause to scope the enumeration (e.g., only values where `year=2020`).

**Quirks discovered during API probing:**
- Default limit is 1000 rows. No enforced maximum -- `$limit=50000` works but returns massive payloads.
- Column types in responses are always strings (even numbers). The server should parse numeric columns based on schema metadata.
- Year columns vary -- some datasets store year as a number, others as text. The `where` clause must match the actual type.
- Aggregate queries (`$group`) return computed columns as strings.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| Invalid dataset ID format | ID doesn't match `[a-z0-9]{4}-[a-z0-9]{4}` | Check the ID from `cdc_discover_datasets` output |
| Dataset not found (404) | Valid format but ID doesn't exist | Search again with `cdc_discover_datasets` |
| SoQL syntax error (400) | Malformed `where`/`select`/`group` clause -- common causes: unquoted string literals (use single quotes: `state='California'`), type mismatch (comparing text column to number or vice versa), referencing nonexistent column names | Check column names and types via `cdc_get_dataset_schema`, fix quoting, and retry |
| Type mismatch in WHERE | Comparing a text-typed year column with a number (`year=2020` vs `year='2020'`) | Inspect the column's `dataType` from schema -- use quotes for text, bare values for numbers |
| Empty results | Query is valid but no rows match the filter | Broaden the `where` clause. Use the column-values pattern above to check what values actually exist |
| Rate limited (429) | Too many requests without app token | Retry after brief delay. Use `CDC_APP_TOKEN` for higher limits |
| Response timeout | Query too broad or dataset too large without filters | Add a `where` clause to narrow scope, reduce `limit`, or add `select` to reduce payload size |

**Query API:** `GET https://data.cdc.gov/resource/{datasetId}.json?$select=...&$where=...`

---

## Resources

### `cdc://datasets`

List of all dataset categories with counts. Provides an overview of the CDC data landscape for orientation.

**Pagination:** The catalog contains ~1,487 datasets. This resource returns a paginated list using `limit`/`offset` query parameters on the underlying Discovery API (`GET https://api.us.socrata.com/api/catalog/v1?domains=data.cdc.gov&limit=50&offset=0`). Default page size: 50. Response includes `totalCount` so agents can determine remaining pages.

### `cdc://datasets/{datasetId}`

Dataset metadata and schema. Equivalent to `cdc_get_dataset_schema` -- useful for injecting dataset context directly. `datasetId` must match `[a-z0-9]{4}-[a-z0-9]{4}`.

---

## Prompts

### `analyze_health_trend`

Structured workflow for investigating a public health question across CDC data. Guides the agent through: (1) discover relevant datasets, (2) inspect schemas, (3) query for baseline data, (4) compare across time/geography/demographics, (5) synthesize findings with caveats about data limitations.

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `topic` | string | Yes | The health topic or question to investigate (e.g., "diabetes mortality trends by state", "childhood vaccination coverage over time", "opioid overdose deaths by demographic"). |
| `timeRange` | string | No | Time period of interest (e.g., "2015-2023", "last 10 years"). Defaults to all available years. |
| `geography` | string | No | Geographic scope -- "national", a specific state name, or "all states" for comparison. Defaults to national. |

---

## Implementation Notes

- **Authentication** -- No API key required. Optional app token via `X-App-Token` header increases rate limits. Without a token, requests are throttled by source IP (undocumented exact limits, but functional for moderate use).
- **Rate limits** -- Unauthenticated requests are throttled (no published rate). With an app token, limits are higher. The SODA API returns no rate-limit headers -- implement conservative request spacing (200-500ms between requests).
- **Response types** -- All values in SODA v2.1 JSON responses are strings, including numbers and dates. Parse based on column type metadata from the schema endpoint.
- **Dataset staleness** -- Some datasets are marked as no longer updated (particularly COVID-era datasets). The `data_updated_at` field from the catalog/metadata API indicates freshness. Surface this to the agent.
- **Suppressed values** -- Some health datasets suppress small counts for privacy. These appear as missing values or footnote markers rather than zeros. Surface footnote columns when present.
- **Large datasets** -- Default limit is 1000 rows. No enforced max, but the server should cap at a sane default (e.g., 5000) to avoid sending 100MB responses to the LLM. Always include the total row count so the agent knows if results are truncated.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CDC_APP_TOKEN` | No | -- | Socrata app token for higher rate limits. Free to register at [data.cdc.gov](https://data.cdc.gov/profile/edit/developer_settings). Without a token, requests are throttled by source IP. |
| `CDC_BASE_URL` | No | `https://data.cdc.gov` | Base URL for all SODA API requests. Override for testing or if the portal domain changes. |

---

## References

- [CDC Open Data Portal](https://data.cdc.gov/)
- [Socrata SODA API Docs](https://dev.socrata.com/) (v2.1 -- current target)
- [SODA3 API](https://dev.socrata.com/docs/queries/) (available, requires auth -- future migration path)
- [Socrata Discovery API](https://socratadiscovery.docs.apiary.io/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
