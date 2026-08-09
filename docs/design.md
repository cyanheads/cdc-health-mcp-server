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

A second, unrelated CDC system sits alongside it: **CDC WONDER**, reached by `cdc_query_wonder`. It answers national mortality questions directly -- deaths, population, and crude/age-adjusted rates from five mortality databases spanning 1999 through the current year, final and provisional, underlying-cause and multiple-cause -- with no catalog, no schema step, and its own protocol. Discovery-first applies to Socrata; WONDER is a single tool whose shape is fixed apart from the `database` selector.

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

Query CDC WONDER for national mortality statistics — deaths, population, and crude/age-adjusted death rates — broken out by year, age group, sex, and/or race, and filtered by ICD-10 cause. WONDER is a separate CDC system from the Socrata portal the other three tools query: different host, different protocol (XML over form-urlencoded POST), no `domain` input, no dataset discovery step. Reach for it when the question is national mortality; reach for the Socrata tools when it is sub-national or not mortality.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `database` | enum | No | Which mortality database to query (table below). Defaults to `underlying_1999_2020`, what the tool queried before the selector existed. |
| `group_by` | enum[] | No | 1–4 of `year`, `age_group`, `sex`, `race`, in output-column order. Defaults to `["year"]`. Results are always national — location is not a grouping dimension. Cause of death is a filter, never a grouping. |
| `cause_icd10` | string | No | ICD-10 underlying-cause code or chapter range (`"I21"`, `"C00-C97"`, `"V01-Y89"`), accepted by every database. Ranges must match WONDER's chapter boundaries exactly. Also takes `999--999`, CDC's marker for causes withheld under the provisional database's reporting lag — that one value is accepted only on `provisional`. Omit for all causes. |
| `mcd_icd10` | string | No | ICD-10 code or range matched against any cause listed on the death certificate. Same form as `cause_icd10`, `999--999` included and under the same `provisional`-only restriction, and combines with it. Valid only on `multiple_1999_2020`, `multiple_2018_2024`, and `provisional`. Omit for all causes. |
| `sex` | enum | No | `all` (default), `male`, or `female`. |
| `age_groups` | enum[] | No | Age-group codes (`1`, `1-4`, `5-14`, … `85+`, `NS`; `1` is under-1-year, `NS` the group for a death whose age was not recorded). A row is included when its age group is any of the listed ones. Omit for all ages. |
| `year_range` | object | No | `{ from, to }`, inclusive, `from <= to`. Bounds span every database (1999 → current year); the selected database's own span is enforced in the handler. Omit for all years. |

**Returns:** `{ rows, rowCount, database, databaseTitle, caveats, cellNotes, messages, suppressedCount }`. Each row carries the requested `group_by` dimensions followed by `deaths`, `population`, `crude_rate`, and — when age standardization is possible — `age_adjusted_rate`, all rates per 100,000. `database` is the selected database's dataset code (`D76`, `D176`, …) and `databaseTitle` CDC's own title for it, so a result names its own source rather than needing one looked up. `caveats` holds CDC's own footnotes for the result set. `effectiveQuery` echoes the database, grouping, and filters as a readable summary.

#### The five databases

Every ID, title, span and variable mapping below was read from that database's own request form and confirmed by a request that returned real data.

| `database` | ID | CDC title | Years | Race variable | Multiple-cause finder |
|:---|:---|:---|:---|:---|:---|
| `underlying_1999_2020` *(default)* | `D76` | Underlying Cause of Death, 1999-2020 | 1999–2020 | `.V8` — bridged, 4 groups | — |
| `provisional` | `D176` | Provisional Mortality Statistics, 2018 through Last Week | 2018 → current year | `.V42` — single race, 6 groups | `.V13` |
| `underlying_2018_2024` | `D158` | Underlying Cause of Death, 2018-2024, Single Race | 2018–2024 | `.V42` | — |
| `multiple_1999_2020` | `D77` | Multiple Cause of Death, 1999-2020 | 1999–2020 | `.V8` | `.V13` |
| `multiple_2018_2024` | `D157` | Multiple Cause of Death, 2018-2024, Single Race | 2018–2024 | `.V42` | `.V13` |

`year` (`.V1-level1`), `age_group` (`.V5`), `sex` (`.V7`) and the underlying-cause finder (`.V2`) carry the same variable code on all five, and their option lists match too apart from two `D176` details the next section covers — the `999--999` marker its cause finders add, and the *All Genders* wording on its `.V7` all-values option. **`race` is the only dimension that genuinely diverges**, and it diverges in meaning as well as code: bridged race collapses Asian and Pacific Islander into one group, single race splits them and adds a multiracial category. A race series from one family cannot be spliced onto one from the other, which is why both the `database` and `group_by` descriptions say so.

The provisional database is a multiple-cause form that also carries the full underlying-cause variable set, so a provisional *underlying-cause* query is `D176` with `cause_icd10` — there is no separate provisional underlying-cause database. Its year cells come back as CDC's own labels (`2025 (provisional)`, `2026 (provisional and partial)`), not bare years, which is why nothing downstream parses a year out of a dimension cell.

#### Fidelity to CDC's own vocabularies

Two questions run through the request builder and the response parser, and they are the same question from either side: does a value the tool hands back read the way CDC wrote it, and can an input express everything the database's own form offers? The line below is where both are drawn. Each `V_*` option list was read off the five request forms.

| CDC variable | What the form offers | What the tool exposes | Status |
|:---|:---|:---|:---|
| `.V5` age | 11 ten-year groups + `NS` (Not Stated), identical on all five | `age_groups` | Complete — all twelve |
| `.V7` sex | `*All*`, `F`, `M` | `sex` — `all`, `male`, `female` | Complete |
| `.V1` year | each database's own year list | `year_range`, bounds per database | Complete |
| `.V2` underlying cause | ICD-10 codes and chapter ranges; `D176` adds `999--999` | `cause_icd10` | Complete — pattern plus the marker |
| `.V13` multiple cause | same, on the three multiple-cause databases | `mcd_icd10` | Complete |
| `.V8` / `.V42` race | 4 bridged / 6 single-race groups, plus `Not Available` on `.V42` | grouping only | No race filter is offered, so nothing omits a value |
| `.V4` / `.V12` / `.V23`, and `.V15` / `.V16` / `.V26` on the multiple-cause side | grouped-cause taxonomies — 113 Cause List (138), 130 Cause List for infants (160), Leading Causes (71), Drug/Alcohol Induced Causes (9) | — | Deliberately absent |
| `.V51` / `.V52` / `.V6` age | five-year, single-year and infant age | — | Deliberately absent |
| `.V17` Hispanic origin, `.V43` / `.V44` other race vocabularies, `.V45` education, `.V11` / `.V18` / `.V19` urbanization, `.V20` autopsy, `.V21` place of death, `.V22` injury intent, `.V24` weekday, `D176`'s occurrence-location and MMWR-week variables | full option lists | — | Deliberately absent; pinned at `*All*` |

**Decision: the deliberately-absent variables stay absent.** Each is a whole dimension rather than a value missing from one the tool already has, so each needs its own input, its own vocabulary in a `.describe()`, and its own answer to how it interacts with `group_by` — a different piece of work from making an existing input faithful, and a wider tool than the four-dimension surface `group_by` describes. The grouped-cause taxonomies are the clearest case: `GR113-001`, `GR130-001` and `D1` are identifiers in a second cause vocabulary, not codes `cause_icd10` could take. The request builder submits every one of them at `*All*`, because WONDER validates the variable block as a whole.

**Decision: `999--999` ships as a value on both cause inputs.** CDC lists it in `D176`'s two ICD-10 finders for deaths whose cause it is still withholding under the provisional database's six-month reporting lag — a real and sizeable stratum (2026, as any listed cause: 123,612 deaths). It is not an ICD-10 code and cannot be written in the shared pattern, so it is accepted as its own literal. The databases whose finders do not list it answer HTTP 500 with `Invalid 'ICD-10 Codes' codes were found: '999--999'. Check the Finder Tool for valid ICD-10 Codes codes.` — correct, but it reads as "no such code" when the code is real and sitting on another database, so the handler rejects that combination first and names `provisional`, in the same shape as the `mcd_icd10` and `year_range` checks.

**Decision: dimension labels are trimmed at the edges and left alone everywhere else.** `D158` and `D157` render their last year as `2024 `; every other year on every database, `D176`'s own 2024 included, comes back bare. Untrimmed, `"2024 " !== "2024"` splits one year into two keys the moment a caller lines a row from one database up against the same year from another, and nothing in the output marks the padded cell as different from the bare one beside it. Whitespace at the edge of a label carries no meaning, so `dimensionLabel` drops it once in the parser rather than leaving every consumer to find it. Nothing inside a label moves: `2025 (provisional)` keeps its interior space, and the age and race labels keep CDC's own wording (`< 1 year`, `More than one race`).

**Two labels the tool never has to reconcile.** `D176` calls its `.V7` all-values option *All Genders* where the other four say *All*; the tool never surfaces that label, since a `*All*` selection means no sex breakdown and a sex grouping returns `Female`/`Male` on every database. And the single-race `.V42` list carries a `Not Available` group — the race analogue of the age `NS` — which can appear as a `race` dimension value; it is CDC's own label and passes through as written.

**IDs are pinned, not resolved per call.** `GET /controller/datarequest/<ID>` returns a plain message page naming the request page an ID belongs to, and a retired or never-allocated ID names none — an unambiguous check that spends no rate-limited POST. `tests/services/wonder/database-ids.test.ts` runs it under `WONDER_LIVE_TESTS=1`, leaving the default test run hermetic. WONDER does mint a new ID per vintage for its archived datasets (cancer runs D144/D151/D160/D172, TB runs D147/D156/D165), so the mortality IDs surviving vintages is the exception rather than the rule and is worth re-checking rather than trusting forever.

**Decision: one tool with a `database` enum, not a tool per database.** The engine, throttle, response parser, error classification and roughly 90% of the parameter scaffold are shared, and the axis that varies is a single enum value. Separate tools would triple a surface to express one dimension, and would leave a caller who wants "the same query, current years" re-reading a second tool's schema to find it unchanged. The divergences that do exist — race vocabulary, year span, whether `mcd_icd10` applies — are per-database facts, so they live in `.describe()` and in a handler validation.

**Decision: each database's fixed-parameter block is built from its own request form.** `POST /controller/datarequest/<ID>` with `stage=about&action-I Agree=I Agree` returns the form; `SCAFFOLDS` in `xml-builder.ts` is transcribed from it. Templating `D76`'s block and swapping the prefix returns HTTP 500 — `The second box of the AND combination for '{0}' contains an entry while the first one is empty` (WONDER leaves the `{0}` unexpanded, so the message does not name the variable). The scaffolds differ structurally, not just in codes: the multiple-cause finders run in `fadv` mode with paired `V_*.V13`/`V_*.V13_AND` textareas D76 has no analogue for, and `D176` carries occurrence-location (`V77`/`V79`/`V80`/`V81`/`V89`/`V90`/`V91`), MMWR-week (`V100`) and 2023-urbanization (`V18`/`V82`) variables D76 lacks while omitting D76's weekday variable (`V24`).

**Decision: the multiple-cause databases ship only together with `mcd_icd10`.** Grouped by year with no multiple-cause filter, `D77` returns `D76`'s figures to the digit — each death is still counted once, by its underlying cause. Offering the database without the filter would be surface area for a no-op. With the filter it answers a question no underlying-cause query can: `D77` filtered to `J00-J98` as any listed cause returns 746,954 deaths for 2019 and 1,031,759 for 2020, against ~2.85 M and ~3.38 M all-cause — the "died with a respiratory condition recorded anywhere on the certificate" population. Selecting a multiple-cause database without the filter is met with a notice naming the underlying-cause database that returns the same numbers. `provisional` is exempt from that notice: its years run past where the final databases stop, so selecting it is never a no-op.

**Decision: the per-database year span is enforced in the handler, not the schema.** `year_range`'s bounds are the union of every database's span, so the emitted JSON Schema stays a plain numeric range a client can read. The cross-field check deliberately avoids a Zod `refine`/`superRefine`: a refinement contributes nothing to the emitted schema, so a client never sees the constraint, and a schema rejection throws a raw `ZodError` as `-32602` at the transport before the handler runs — which puts the declared `recovery` hint out of reach. That is the defect #27 corrected for `cdc_discover_datasets`. The handler check fails with the declared `invalid_query` reason and a message naming the selected database's actual span; the `mcd_icd10` and `999--999` rejections follow the same pattern.

**Age-adjusted rate is not a measure code.** `O_aar=aar_std` produces the column; no mortality database defines an `M4`, `D76` included. Only `M_1..M_3` (deaths, population, crude rate) are ever sent — a `D76` request carrying `O_aar=aar_std` and no `M_4` returns the age-adjusted column normally (1999: deaths 2,391,399 · population 279,040,168 · crude 857.0 · age-adjusted 875.6).

**Age-adjusted rate is conditional.** It is requested only when WONDER can standardize across age, which rules out the two shapes it rejects: `age_group` used as a grouping dimension (age is then the output axis, not the standardization axis), and an `age_groups` filter narrowed to exactly one group. In both cases the column is simply absent from every row rather than null.

**Status tokens in place of numbers.** A measure cell can come back as `Suppressed` (withheld for confidentiality — figures representing fewer than 10 persons), `Unreliable` (a rate computed from fewer than 20 deaths; published, not withheld), or `Not Applicable` (no population denominator). The parser nulls the cell in `rows` and records it in `cellNotes` as `{ row, column, token }`; `suppressedCount` counts the `Suppressed` ones. `rows` alone cannot tell a withheld value from an unreliable one or a genuinely absent one — `cellNotes` is what does.

**Hidden rows, and why they need their own disclosure.** A status token marks a cell WONDER withheld inside a row that still arrived. WONDER also drops rows outright before sending the table: `suppress-zeros` and `suppress-counts` are on for every mortality database, so a stratum with zero deaths and a stratum whose death count falls under the suppression threshold never appear at all. Nothing in the table records the omission — the surviving rows simply read as the whole answer, and a caller cannot separate "this stratum has no deaths" from "this stratum was dropped." WONDER states it instead in `<message>` elements on the 200: `Rows with zero Deaths are hidden.` and `Rows with suppressed Deaths are hidden.`, alongside unrelated notices such as the one about totals being unavailable under suppression constraints. `parseMessages` reads all of them and `messages` carries them verbatim; the handler turns the hidden-row ones into a notice, and `format()` renders the block under the table so a `content[]`-only client sees it too. An empty result is reported differently when they are present — every matching stratum can be hidden, which reads as zero rows and means the opposite of "nothing matched".

**Decision: disclose the hidden rows, don't unhide them.** `fixedParams()` deliberately omits `O_show_zeros` and `O_show_suppressed`. Sending them would return the dropped rows, but it changes the result set materially rather than adding a field: every zero and sub-threshold stratum enters the table, and the suppressed ones arrive as rows whose measures are all `Suppressed` status tokens — the per-cell disclosure the parser already carries. That is a defensible design, and a bigger one than a disclosure: it needs its own pass over row-count growth at fine groupings, over how a fully-tokenized row should render, and over whether it belongs behind an input. Disclosure answers the question that was actually wrong (the caller not knowing) without moving the data contract, so it ships first and unhiding stays open.

**Upstream constraints encoded in the request builder:**

- **National only.** Sub-national grouping and filtering are blocked by CDC vital-statistics policy, so location (`.V9`/`.V10`/`.V27`, plus the occurrence-location finders on `D176`) is pinned to `*All*` and never exposed as an input.
- **Every request must carry a rate measure.** A deaths-only measure set is rejected by the WONDER engine, so deaths, population, and crude rate are always requested.
- **A year filter must be set on the finder as well as the value.** Listing specific years in `V_<ID>.V1` while leaving `F_<ID>.V1` at `*All*` is rejected as a conflicting selection, so both carry the year list.
- **Bare headers.** WONDER sits behind a bot filter that rejects browser-*claiming* clients — a browser User-Agent plus Origin/Referer with a non-browser TLS fingerprint draws a 403. Requests carry only `Content-Type`.
- **One request per 16 seconds, measured from the end of the previous response.** WONDER documents 15 s, but the window is not anchored on the previous request: a request sent 15.01 s after the previous one *started* (14.11 s after its response) is rejected, while 15.21 s after the response is accepted. The service therefore stamps the clock after it has read the response body — on every exit path, since a network error, a 429, and a malformed body all consumed a request — and waits 16 s from there, leaving margin for clock skew and upstream jitter. The 429 carries no `Retry-After` and does not lengthen the window, so a fixed interval is enough; there is no backoff state. The limit is per source IP and shared across databases, so one process-wide gap is the correct shape.

**Error modes:**

| Error | Cause | Recovery |
|:------|:------|:---------|
| `invalid_query` | A `year_range` outside the selected database's span, `mcd_icd10` against a database that records only the underlying cause, or `999--999` against one that keeps no withheld-cause backlog — all three rejected in the handler before any request is sent. Or WONDER itself answered with a `<message>`: an unknown or misaligned ICD-10 code, or a filter/grouping combination it forbids | Read the returned message — it names the span the selected database holds, the databases that accept `mcd_icd10` or `999--999`, or the part WONDER rejected. Adjust `year_range`, switch `database`, drop the filter, or correct the ICD-10 code, and retry |
| `rate_limited` (429) | A request reached WONDER less than 15 seconds after the previous response finished | Wait at least 16 seconds after the previous response completes, then retry |
| `upstream_error` | Unreachable, a failure with no `<message>` to explain it, or a 200 carrying no `<data-table>` | Retry after a brief delay; wonder.cdc.gov may be temporarily unavailable |
| Empty results | Valid query, no matching deaths — or every matching row hidden upstream, which `messages` distinguishes | Broaden `cause_icd10`, `sex`, `age_groups`, or `year_range`, or confirm the ICD-10 code covers the years selected |

**WONDER API:** `POST https://wonder.cdc.gov/controller/datarequest/<ID>` where `<ID>` is the selected database's dataset code, form-urlencoded with a `request_xml` document; the response is an XML `<data-table>`. Not configurable — unlike Socrata, there is no second host.

**Not covered:** natality, compressed-mortality, cancer, and STD databases. Each is its own WONDER dataset with its own measures and variables, not a `database` value away.

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

Structured workflow for investigating a public health question across CDC data. Opens by settling which of the two systems answers the question — `cdc_query_wonder` when it is national mortality with an ICD-10-expressible cause, the Socrata trio for sub-national detail and non-mortality topics — then guides the agent through: (1) discover relevant datasets, (2) inspect schemas, (3) query for baseline data, (4) compare across time/geography/demographics, (5) synthesize findings with caveats about data limitations. Steps 1 and 2 branch by source: the WONDER path has nothing to discover and a fixed shape, so it goes straight to the baseline query.

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
