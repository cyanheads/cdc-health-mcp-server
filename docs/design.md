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

Wraps the [CDC Open Data portal](https://data.cdc.gov/) (~1,080 datasets among ~1,471 catalog entries) via the [Socrata SODA API](https://dev.socrata.com/) to enable discovery, exploration, and querying of public health data. Covers disease surveillance, mortality, behavioral risk factors, vaccinations, environmental health, injury statistics, and more. No authentication required -- app token optional for higher rate limits.

The core challenge: ~1,080 datasets with heterogeneous schemas. The server provides a discovery-first workflow -- find the right dataset, inspect its schema, then query it -- rather than hard-coding knowledge of specific datasets.

A second, unrelated CDC system sits alongside it: **CDC WONDER**, reached by `cdc_query_wonder`. It answers national mortality questions directly -- deaths, population, and crude/age-adjusted rates from database D76 (Underlying Cause of Death, 1999--2020) -- with no catalog, no schema step, and its own protocol. Discovery-first applies to Socrata; WONDER is a single tool with a fixed shape.

**Dependencies**: `@cyanheads/mcp-ts-core`, Socrata SODA API v2.1 (public, optional app token), CDC WONDER's `datarequest` XML API (public, no auth). SODA3 (`/api/v3/views/{id}/query.json`) is available with mandatory auth but SODA 2.1 remains fully supported. Target SODA 2.1 for now -- no auth required for basic access.

---

## Tools

### `cdc_discover_datasets`

Search the CDC dataset catalog by keyword, category, or tag. Returns dataset IDs, names, truncated descriptions, a column count with a short column sample, and update timestamps. This is the entry point -- use before querying to find the right dataset for a question. Full column detail comes from `cdc_get_dataset_schema`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | enum | No | CDC Socrata portal to search: `data.cdc.gov` (default) or `chronicdata.cdc.gov`. Allowlisted -- any other host is rejected at input validation. |
| `query` | string | No | Full-text search across dataset names and descriptions (e.g., "diabetes mortality", "lead exposure children"). |
| `category` | string | No | Filter by domain category. Common values: "National Center for Health Statistics", "NNDSS", "Vaccinations", "Public Health Surveillance", "Behavioral Risk Factors", "Motor Vehicle", "Maternal & Child Health". |
| `tags` | string[] | No | Filter by domain tags (e.g., ["covid19", "surveillance"]) — see the tag semantics note below; multiple tags widen the result set rather than narrowing it. |
| `limit` | number | No | Results to return (default 10, max 100). |
| `offset` | number | No | Pagination offset for browsing beyond first page (max 9999). `offset + limit` must not exceed 10,000 — see the pagination note below. |

**Returns:** Array of `{ id, name, assetType, description, category, tags, columnCount, columnSample, updatedAt, pageViews }`. `description` is truncated to 300 characters; `columnSample` lists the first 8 column field names (the full list lives in `cdc_get_dataset_schema`). Includes `totalCount` for pagination.

**Non-dataset catalog assets:** the Discovery API returns `chart`, `map`, `story`, `file`, and `href` entries alongside `dataset` ones, each with a four-by-four ID. `assetType` carries the catalog's own label, but it is descriptive, not a queryability test — a `filter` asset has real columns and queries normally, while `chart` and `map` assets report `viewType: "tabular"` with no columns at all. The signal that tracks real queryability is `columnCount === 0`, and the server keys its behavior off that rather than off the type. Filtering the catalog to `only=datasets` would hide the queryable `filter` entries, so the server does not.

**Tag semantics:** the Discovery API takes one `tags` parameter per value and unions them — a dataset matches when it carries any one of the listed tags, so each tag added returns more results, not fewer. Measured against `data.cdc.gov`: `covid19` alone matches 19 entries, `vaccination` alone 41, and the two together 59 (the two sets overlap in one dataset). Tag values match the catalog's own vocabulary, case-insensitively; a value no dataset carries matches nothing and leaves the count unchanged (`["covid19","zzzznotag"]` returns the same 19 as `covid19` alone), which is indistinguishable from a real tag with no matches. The other dimensions intersect: `tags=covid19` plus `categories=Vaccinations` narrows to 1, and `q=diabetes` plus `tags=covid19` likewise narrows to 1. `tags` is the only multi-value filter the server exposes where union and intersection are both plausible readings — `cdc_query_wonder`'s `age_groups` also unions, but a death falls in exactly one age group, so any-of is its only coherent reading.

**Pagination ceiling:** the Discovery API rejects any request whose `offset + limit` exceeds 10,000 with a 400 pointing at its deep-scrolling API. The bound is on the sum, which no pair of independent per-field maxima can express (`offset: 9999, limit: 5` clears both and still fails upstream), so the tool checks it in the handler and fails with `page_out_of_range` before the request. Both portals report ~1,471 catalog entries, so the ceiling is unreachable by legitimate paging.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| Empty results | No datasets match query/category/tags combination | Broaden search terms, try fewer filters, or use `query` alone without `category`/`tags` |
| Offset past `totalCount` | Valid search, but the page starts beyond the last result | Distinguished from a no-match in the returned notice, which names `totalCount`; lower `offset` below it |
| `page_out_of_range` | `offset + limit` above 10,000 | Rejected before the request. Lower `offset`, `limit`, or both so the sum is at most 10,000 |
| `access_denied` (403) | Catalog refused the request | Permanent — do not retry. Drop category/tag filters and search with `query` alone |
| Rate limited (429) | Too many requests to Socrata Discovery API | Retry after brief delay. Consider using an app token for higher limits |
| Catalog API timeout | Discovery API occasionally slow under load | Retry once. Reduce `limit` if fetching large pages |

**Catalog API:** `GET https://api.us.socrata.com/api/catalog/v1?domains={domain}` where `{domain}` is `data.cdc.gov` (default) or `chronicdata.cdc.gov`.

---

### `cdc_get_dataset_schema`

Fetch the full column schema for a dataset -- names, data types, descriptions. Essential before writing queries against unfamiliar datasets. Also returns dataset name, description, row count, and last-updated timestamp.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | enum | No | CDC Socrata portal hosting the dataset: `data.cdc.gov` (default) or `chronicdata.cdc.gov`. Must match the portal the dataset was found on. |
| `datasetId` | string | Yes | Four-by-four dataset identifier matching `[a-z0-9]{4}-[a-z0-9]{4}` (e.g., "bi63-dtpu"). Obtain from `cdc_discover_datasets`. |

**Returns:** `{ name, description, rowCount, updatedAt, columns: [{ fieldName, dataType, description }] }`.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| Invalid dataset ID format | ID doesn't match `[a-z0-9]{4}-[a-z0-9]{4}` | Check the ID from `cdc_discover_datasets` output -- IDs are always 9 characters like "bi63-dtpu" |
| Dataset not found (404) | Valid format but ID doesn't exist or was deleted | Search again with `cdc_discover_datasets` -- the dataset may have been replaced or retired |
| `not_queryable` | The metadata endpoint answered 200 with zero columns -- the ID names a chart, map, story, file, or external link | Pick an ID from `cdc_discover_datasets` whose `columnCount` is above zero |
| `access_denied` (403) | Asset not readable through this endpoint, or access restricted | Permanent -- do not retry. Choose a different ID |
| Rate limited (429) | Too many requests | Retry after brief delay |

**Metadata API:** `GET https://{domain}/api/views/{datasetId}.json` where `{domain}` is `data.cdc.gov` (default) or `chronicdata.cdc.gov`.

---

### `cdc_query_dataset`

Execute a SoQL query against any CDC dataset. Supports filtering, aggregation, sorting, full-text search, and field selection. This is the workhorse -- once you know the dataset ID and column names, use this to extract data.

Accepts either a convenience `search` parameter for simple full-text queries, or individual SoQL clauses for full control. At least one of `search`, `where`, or `select` must be provided.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | enum | No | CDC Socrata portal hosting the dataset: `data.cdc.gov` (default) or `chronicdata.cdc.gov`. Must match the portal the dataset lives on. |
| `datasetId` | string | Yes | Four-by-four dataset identifier matching `[a-z0-9]{4}-[a-z0-9]{4}`. |
| `search` | string | No | Convenience full-text search across all text columns. Use for exploratory queries. For precise filtering, use `where` instead. |
| `select` | string | No | SoQL SELECT clause. Column names, aliases, aggregates: `"state, sum(deaths) as total_deaths"`. Omit for all columns. |
| `where` | string | No | SoQL WHERE clause. Supports `=`, `!=`, `>`, `<`, `>=`, `<=`, `AND`, `OR`, `NOT`, `IS NULL`, `IS NOT NULL`, `LIKE`, `IN(...)`, `BETWEEN`, `starts_with()`, `contains()`. Strings must be single-quoted: `"state='California' AND year=2020"`. Column names matching SoQL keywords (`group`, `select`, `where`, `order`, `limit`, `offset`, `having`, `search`) must be backtick-escaped: `` `group`='By Year' ``. |
| `group` | string | No | SoQL GROUP BY clause. Requires aggregate functions in `select`. |
| `having` | string | No | SoQL HAVING clause. Filters aggregated results. |
| `order` | string | No | SoQL ORDER BY clause. Field name with optional `ASC`/`DESC`: `"total_deaths DESC"`. |
| `limit` | number | No | Max rows to return (default 100, max 5000). Use with `offset` for pagination. |
| `offset` | number | No | Row offset for pagination. |

**Returns:** Array of row objects with requested fields. Includes `rowCount` (length of returned rows) and `effectiveQuery` — the SoQL clauses sent to Socrata as `$clause=value` pairs joined by `&`, each value in the caller's own text rather than URL-encoded, so a clause can be copied straight back into the parameter it came from. It is an echo for reading and replay, not a URL-ready string: the wire request percent-encodes these values, and `URLSearchParams` writes a space as `+` there, so decoding that encoded form is what would turn every space in a clause into a plus sign.

**Tip -- enumerating column values:** To see distinct values for a column (e.g., what states or years exist), use `select: "{column}, count(*) as count"`, `group: "{column}"`, `order: "count DESC"`. Add a `where` clause to scope the enumeration (e.g., only values where `year=2020`).

**Quirks discovered during API probing:**
- Socrata's own `$limit` default is 1000 with no upstream ceiling -- `$limit=50000` works but returns massive payloads. The wrapper enforces a 5000-row schema max and a 100-row default to keep typical responses manageable.
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
| Column not in GROUP BY (400) | `select` mixes a non-aggregated column with an aggregate (e.g. `state, sum(deaths)`) without a matching `group` | Add the column to `group`, or wrap it in an aggregate like `sum()` |
| Reserved-word column name (400) | A column name matches a SoQL keyword (e.g. a column literally named `group`) and isn't escaped | Backtick-escape the column in the clause: `` `group`='By Year' `` |
| Empty results | Query is valid but no rows match the filter | Broaden the `where` clause. Use the column-values pattern above to check what values actually exist |
| `access_denied` (403) | ID names a non-tabular catalog asset (`no row or column access to non-tabular tables`) | Permanent -- do not retry. Confirm the ID with `cdc_get_dataset_schema`, then query one whose schema lists columns |
| Rate limited (429) | Too many requests without app token | Retry after brief delay. Use `CDC_APP_TOKEN` for higher limits |
| Response timeout | Query too broad or dataset too large without filters | Add a `where` clause to narrow scope, reduce `limit`, or add `select` to reduce payload size |

**Query API:** `GET https://{domain}/resource/{datasetId}.json?$select=...&$where=...` where `{domain}` is `data.cdc.gov` (default) or `chronicdata.cdc.gov`.

---

### `cdc_query_wonder`

Query CDC WONDER database D76 (Underlying Cause of Death, 1999–2020) for national mortality statistics — deaths, population, and crude/age-adjusted death rates — broken out by year, age group, sex, and/or race, and filtered by ICD-10 underlying cause. WONDER is a separate CDC system from the Socrata portal the other three tools query: different host, different protocol (XML over form-urlencoded POST), no `domain` input, no dataset discovery step. Reach for it when the question is national mortality within 1999–2020; reach for the Socrata tools when it is sub-national, post-2020, or not mortality.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `group_by` | enum[] | No | 1–4 of `year`, `age_group`, `sex`, `race`, in output-column order. Defaults to `["year"]`. Results are always national — location is not a grouping dimension. Cause of death is a filter, never a grouping. |
| `cause_icd10` | string | No | ICD-10 underlying-cause code or chapter range (`"I21"`, `"C00-C97"`, `"V01-Y89"`). Ranges must match WONDER's chapter boundaries exactly. Omit for all causes. |
| `sex` | enum | No | `all` (default), `male`, or `female`. |
| `age_groups` | enum[] | No | Ten-year age-group codes (`1`, `1-4`, `5-14`, … `85+`; `1` is under-1-year). A row is included when its age group is any of the listed ones. Omit for all ages. |
| `year_range` | object | No | `{ from, to }`, inclusive, each within 1999–2020, `from <= to`. Omit for all years. |

**Returns:** `{ rows, rowCount, database, caveats, cellNotes, suppressedCount }`. Each row carries the requested `group_by` dimensions followed by `deaths`, `population`, `crude_rate`, and — when age standardization is possible — `age_adjusted_rate`, all rates per 100,000. `caveats` holds CDC's own footnotes for the result set. `effectiveQuery` echoes the grouping and filters as a readable summary.

**Age-adjusted rate is conditional.** It is requested only when WONDER can standardize across age, which rules out the two shapes it rejects: `age_group` used as a grouping dimension (age is then the output axis, not the standardization axis), and an `age_groups` filter narrowed to exactly one group. In both cases the column is simply absent from every row rather than null.

**Status tokens in place of numbers.** A measure cell can come back as `Suppressed` (withheld for confidentiality — figures representing fewer than 10 persons), `Unreliable` (a rate computed from fewer than 20 deaths; published, not withheld), or `Not Applicable` (no population denominator). The parser nulls the cell in `rows` and records it in `cellNotes` as `{ row, column, token }`; `suppressedCount` counts the `Suppressed` ones. `rows` alone cannot tell a withheld value from an unreliable one or a genuinely absent one — `cellNotes` is what does.

**Upstream constraints encoded in the request builder:**

- **National only.** Sub-national grouping and filtering are blocked by CDC vital-statistics policy, so location (`D76.V9`/`V10`/`V27`) is pinned to `*All*` and never exposed as an input.
- **Every request must carry a rate measure.** A deaths-only measure set is rejected by the WONDER engine, so deaths, population, and crude rate are always requested.
- **A year filter must be set on the finder as well as the value.** Listing specific years in `V_D76.V1` while leaving `F_D76.V1` at `*All*` is rejected as a conflicting selection, so both carry the year list.
- **Bare headers.** WONDER sits behind a bot filter that rejects browser-*claiming* clients — a browser User-Agent plus Origin/Referer with a non-browser TLS fingerprint draws a 403. Requests carry only `Content-Type`.
- **One request per 15 seconds.** The service enforces the gap itself; a closer pair returns 429.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| `invalid_query` | WONDER answered with a `<message>` — an unknown or misaligned ICD-10 code, or a filter/grouping combination it forbids | Read the returned message, which names the rejected part; correct `cause_icd10` or the grouping/filter combination and retry |
| `rate_limited` (429) | Requests less than 15 seconds apart | Wait at least 15 seconds between WONDER queries, then retry |
| `upstream_error` | Unreachable, a failure with no `<message>` to explain it, or a 200 carrying no `<data-table>` | Retry after a brief delay; wonder.cdc.gov may be temporarily unavailable |
| Empty results | Valid query, no matching deaths | Broaden `cause_icd10`, `sex`, `age_groups`, or `year_range`, or confirm the ICD-10 code covers the years selected |

**WONDER API:** `POST https://wonder.cdc.gov/controller/datarequest/D76`, form-urlencoded with a `request_xml` document; the response is an XML `<data-table>`. Not configurable — unlike Socrata, there is no second host.

**Not covered:** provisional and post-2020 mortality (database D176) and multiple-cause-of-death (D77) diverge in both schema and parameters; D76 is the only database this tool queries.

---

## Resources

### `cdc://datasets`

The catalog's 50 most-viewed entries, each as `{ id, name, assetType, category, columnCount, updatedAt }`, for orientation in the CDC data landscape.

It reads the same catalog as `cdc_discover_datasets` and returns the same mix of asset types — the live top 50 carries two charts, a story, and two `filter` entries alongside the datasets. `columnCount` is what separates them: an entry reporting 0 is not tabular, and neither `cdc_get_dataset_schema` nor `cdc_query_dataset` returns anything for its ID.

**Pagination:** the underlying Discovery API takes `limit`/`offset` (`GET https://api.us.socrata.com/api/catalog/v1?domains=data.cdc.gov&limit=50&offset=0`); this resource pins them at 50 and 0 and accepts no caller input. `totalCount` (~1,471 entries) comes back with the page — use `cdc_discover_datasets` to page past the first 50.

### `cdc://datasets/{datasetId}`

Dataset metadata and schema, addressable by URI. Same payload as `cdc_get_dataset_schema`, and the same failures — including `not_queryable` when the ID names a catalog asset with no columns. `datasetId` must match `[a-z0-9]{4}-[a-z0-9]{4}`.

---

## Prompts

### `analyze_health_trend`

Structured workflow for investigating a public health question across CDC data. Opens by settling which of the two systems answers the question — `cdc_query_wonder` when it is national mortality within 1999–2020 with an ICD-10-expressible cause, the Socrata trio for sub-national detail, years after 2020, and non-mortality topics — then guides the agent through: (1) discover relevant datasets, (2) inspect schemas, (3) query for baseline data, (4) compare across time/geography/demographics, (5) synthesize findings with caveats about data limitations. Steps 1 and 2 branch by source: the WONDER path has nothing to discover and a fixed shape, so it goes straight to the baseline query.

The routing is prose the reading model acts on, not a classification the handler performs — the generated message is identical whatever `topic` says. A topic keyword test in `generate` would fail exactly where the question is ambiguous, and would need re-tuning every time either system's coverage moves; stating the conditions leaves that judgment with the reader, who has the full question. `tests/mcp-server/prompts/definitions/analyze-health-trend.prompt.test.ts` holds the text to the tool surface: every backticked identifier must resolve to a real tool name, field, or enum member, and the year span the WONDER guidance advertises is read off `cdc_query_wonder`'s own input schema rather than hard-coded.

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
- **Large datasets** -- Default limit is 100 rows; schema enforces a 5000-row max. Always include the total row count so the agent knows if results are truncated.
- **Error classification** -- `SocrataService.fetchJson` is shared by all five definitions (both catalog consumers, both metadata consumers, and the query tool), and each handler re-dispatches on `err.data.reason` alone, discarding the HTTP-derived code. A reason therefore has to be true for every status it covers, and has to be declared by every consumer that can raise it — `ctx.fail` with an undeclared reason returns an `InternalError` whose data carries the full declared-reason list to the caller. Statuses observed live against both portals:

  | Status | Endpoint | Trigger | Permanent? | Reason | Code |
  |:---|:---|:---|:---|:---|:---|
  | 400 | `/resource`, catalog | Malformed SoQL, unknown column, type mismatch, `offset + limit > 10000` | Permanent | `invalid_query` / `no_such_column` / `type_mismatch` | ValidationError |
  | 403 | `/resource` | Non-tabular asset ID | Permanent | `access_denied` | Forbidden |
  | 404 | `/api/views`, `/resource`, catalog | ID or endpoint does not exist | Permanent | `dataset_not_found` | NotFound |
  | 429 | any | Rate limiting | Transient | `rate_limited` | RateLimited |
  | 5xx | any | Upstream outage | Transient | `upstream_error` | ServiceUnavailable |
  | other 4xx | any | Unobserved (401, 410, 451, …) | Varies | none — bubbles with the framework's own classification | per status |

  `upstream_error` is scoped to 5xx precisely because it is the only reason marked retryable; a 403 routed through it told callers to retry a permanent refusal and to expect the portal was down. Statuses outside the table carry no reason at all, so the handlers rethrow them and the framework's status mapping survives instead of being flattened into a reason that is not true.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CDC_APP_TOKEN` | No | -- | Socrata app token for higher rate limits. Free to register at [data.cdc.gov](https://data.cdc.gov/profile/edit/developer_settings). Without a token, requests are throttled by source IP. |
| `CDC_BASE_URL` | No | `https://data.cdc.gov` | Base URL for SODA API requests when a call does not name a `domain`. Override for testing or if the portal domain changes. |
| `CDC_CATALOG_URL` | No | `https://api.us.socrata.com/api/catalog/v1` | Base URL for Socrata Discovery API requests — the catalog search behind `cdc_discover_datasets` and `cdc://datasets`. Separate from `CDC_BASE_URL` because discovery is served by Socrata's cross-portal catalog rather than by either CDC host. |

---

## References

- [CDC Open Data Portal](https://data.cdc.gov/)
- [Socrata SODA API Docs](https://dev.socrata.com/) (v2.1 -- current target)
- [SODA3 API](https://dev.socrata.com/docs/queries/) (available, requires auth -- future migration path)
- [Socrata Discovery API](https://socratadiscovery.docs.apiary.io/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
