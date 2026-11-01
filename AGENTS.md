# Agent Protocol

**Server:** cdc-health-mcp-server
**Version:** 0.11.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.18`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.4.0
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

Wraps the [CDC Open Data portal](https://data.cdc.gov/) (~1,080 datasets) via the [Socrata SODA API v2.1](https://dev.socrata.com/). No auth required — optional app token for higher rate limits.

**Core workflow:** discover → inspect schema → query. The catalog is heterogeneous (disease surveillance, mortality, behavioral risk, vaccinations, environmental, injury, etc.), so the server provides a discovery-first approach rather than hard-coding dataset knowledge.

### API Surface

**Design doc:** `docs/design.md` — full parameter tables, error modes, API endpoints, and implementation notes.

The four Socrata tools take an allowlisted `domain` input (`data.cdc.gov` default, `chronicdata.cdc.gov`) — Zod `z.enum` rejects any other host before the handler runs (the SSRF guard). The two `cdc://datasets…` resources stay on the default host. `cdc_query_wonder` hits a different CDC system and takes no `domain`; its `database` enum picks the dataset code in the upstream path, and is the same kind of guard.

| Definition | Type | Purpose |
|:-----------|:-----|:--------|
| `cdc_discover_datasets` | tool | Search catalog by keyword/category/tag/asset type. Entry point. Trimmed payload — `assetType`, `permalink`, `columnCount` + an 8-name `columnSample` and a 300-char description, cut *after* the markup comes off, plus `accessPoints` (the publisher-labelled URLs of a link entry) and `parentIds` (the datasets a chart, map, filter, or story is built on); full column detail comes from `cdc_get_dataset_schema`. `limit` is the page (default 10, up to 10,000, never clamped): `offset + limit` above 10,000 fails `page_out_of_range`, checked on the raw limit. `asset_types` (the `assetType` values) sends their plurals as one `only` parameter. `order` defaults to `relevance` when `query` is set and `dataset_id` otherwise, at every offset; a relevance page with matches remaining carries a notice that offset paging can repeat or skip entries. |
| `cdc_get_dataset_schema` | tool | Fetch column schema, row count, metadata for a dataset ID. Full-detail surface, windowed — `column_limit` (default 100, no maximum: it slices a schema fetched whole) / `column_offset`, with `totalCount`/`truncated`/`nextOffset` enrichment. The dataset `description` is capped at 4,000 characters by default (`truncatePlainText`), with `descriptionTruncated`/`descriptionLength` set when cut; `full_description: true` returns it whole. Column descriptions are never shortened. `rowCount` prefers a live `count(*)`, with `rowCountSource` naming `live` or the `cached` fallback. Provenance, where the publisher recorded it: `parentId` (a filter's source dataset), and `temporalCoverage`, `updateFrequency`, `geographicCoverage`, `citation`, `license`, `attribution` as the publisher's own text, never parsed. Fails `not_queryable` on a non-tabular asset instead of returning empty columns; a chart or map's failure names its parent dataset (`parentId`) in the message and recovery hint. |
| `cdc_list_catalog_vocabulary` | tool | The catalog's `category` and `tags` vocabularies with entry counts, per allowlisted domain. Categories whole; tags ranked by count and paged — `tag_limit` (default 50, no maximum: it slices a vocabulary fetched whole) / `tag_offset`, with `vocabularySize`/`categoryCount`/`tagCount`/`truncated`/`truncationCeiling`/`nextOffset` enrichment. `truncationCeiling` bounds only the tags from `nextOffset` on — on a later page the tags before `tag_offset` outrank it. `filter` narrows both vocabularies before the page is cut. |
| `cdc_query_dataset` | tool | Execute SoQL queries — filter, aggregate, sort, full-text search. `limit` is the page, clamped to 1,000 rows — `effectiveQuery` echoes `$limit=1000`, and the notice names the clamp when rows remain past the page (SODA sets no maximum of its own; `select` narrows each row of a wide dataset); up to the clamp a page ends short of `limit` only at the end of the result set. Continuation is measured by an over-fetch probe, not the row count; discloses `truncated`/`shown`/`cap`/`nextOffset`, never a `totalCount`. An empty page at `offset > 0` spends one probe at offset 0 to tell an offset past the end from a no-match. Fails `not_queryable` when every row comes back with no fields and the asset has no columns, naming the chart or map's parent dataset. |
| `cdc_query_wonder` | tool | Query CDC WONDER for national deaths, population, crude/age-adjusted rates, each rate with its 95% confidence interval (`<rate>_lower`/`<rate>_upper`). Grouped by year, month, age group, sex, race, Hispanic origin, or underlying cause (ICD chapter or sub-chapter, the 113-cause list, the 15 leading causes, injury intent), filtered by ICD-10 cause. A `database` enum selects one of five mortality databases — D76 (default), D176 provisional, D158, D77, D157. `limit` is the page, lowered to a 10,000-row per-call ceiling — the table-size bound, so one call holds any table the handler accepts; an omitted `limit` returns the rest of the table from `offset`. `limit`/`offset` page the parsed rows with exact `totalCount`/`truncated`/`nextOffset`, re-basing `cellNotes` onto the page while `caveats`/`messages` stay whole. |
| `cdc://datasets` | resource | 50 most-viewed catalog entries for orientation — carries `assetType` + `columnCount`, since the page mixes charts/stories/filters in with datasets. |
| `cdc://datasets/{datasetId}` | resource | Dataset metadata + the first 100 columns and a description capped at 4,000 characters, carrying `columnCount`/`truncated`/`descriptionTruncated`/`descriptionLength`, the same `parentId` and publisher provenance fields as `cdc_get_dataset_schema`, and one composed `notice` naming `column_offset` and `full_description: true` on `cdc_get_dataset_schema`. Takes no selector — the SDK's `UriTemplate.match` compiles RFC 6570 query variables as *required*, so `{?column_limit,column_offset}` would stop the bare URI matching at all. |
| `analyze_health_trend` | prompt | Guided workflow: pick the source (WONDER for national mortality, leading-cause, Hispanic-origin, and seasonal questions; Socrata otherwise), then discover → inspect → query → compare (rates by their confidence intervals) → synthesize (provisional partial year, `updateFrequency`/`temporalCoverage`). Routing is prose the reader acts on — the handler never classifies the topic. |

### Socrata API Endpoints

`{domain}` is allowlisted to `data.cdc.gov` (default) or `chronicdata.cdc.gov`, selected per call via the `domain` tool input. The two are front doors onto one Socrata tenant — a single catalog labelled `data.cdc.gov`, whose assets all resolve by four-by-four ID on either host — so `domain` picks which host answers, never which assets are reachable. No surface may name PLACES, the Heart Disease & Stroke Atlas, or Environmental Public Health Tracking as though `chronicdata.cdc.gov` were the way to reach them; `tests/services/socrata/socrata-domain-semantics.test.ts` pins that. The app token works unchanged across both hosts.

| Endpoint | Purpose |
|:---------|:--------|
| `GET https://api.us.socrata.com/api/catalog/v1?domains={domain}` | Discovery/catalog search — the `categories` filter needs `search_context={domain}` alongside `domains` or it matches nothing; `only` takes the plural asset types comma-joined, and an unrecognized one answers an empty page. A nonzero `offset` with `offset + limit` above 10,000 is a 400; `offset=0` answers any `limit` |
| `GET https://api.us.socrata.com/api/catalog/v1/domain_categories?domains={domain}` | Category vocabulary with entry counts (a few dozen values, no paging needed) |
| `GET https://api.us.socrata.com/api/catalog/v1/domain_tags?domains={domain}&limit=10000` | Tag vocabulary with entry counts. **The explicit limit is load-bearing** — without it the endpoint returns 100 values and reports `resultSetSize: 100`, so the under-count reads as complete |
| `GET https://{domain}/api/views/{datasetId}.json` | Dataset metadata + schema |
| `GET https://{domain}/resource/{datasetId}.json?$select=...&$where=...` | SoQL data queries |

### CDC WONDER API

Separate system, separate service (`src/services/wonder/`). `POST https://wonder.cdc.gov/controller/datarequest/<ID>` with a form-urlencoded `request_xml` document; the response is an XML `<data-table>`.

- Five mortality databases behind one tool, keyed by the `database` enum: `D76` (default, 1999–2020), `D176` (provisional, 2018 → current year), `D158` (2018–2024), `D77` and `D157` (multiple-cause). `WONDER_DATABASE_SPECS` in `types.ts` is the source of truth for IDs, titles, spans, race variable, and multiple-cause support.
- **Build each database's fixed-parameter block from its own request form**, never by templating D76's — a prefix swap returns HTTP 500 (`The second box of the AND combination for '{0}' contains an entry while the first one is empty`). `POST /controller/datarequest/<ID>` with `stage=about&action-I Agree=I Agree` returns the form; `SCAFFOLDS` in `xml-builder.ts` is transcribed from it. Multiple-cause finders need paired `V_*.V13`/`V_*.V13_AND` textareas; `D176` carries occurrence-location, MMWR and 2023-urbanization variables D76 lacks and omits D76's weekday variable.
- `race` is the only dimension that diverges — `.V8` bridged (4 groups) on the 1999–2020 pair, `.V42` single race (6 groups) on the rest. The two families' series are not comparable, and every surface naming `race` says so.
- Age-adjusted rate comes from `O_aar=aar_std`, not a measure code — no mortality database has an `M4`. The measure codes sent are `M_1..M_3` plus `M_32`, the crude rate's 95% interval, which `D76` and `D77` omit without it; the age-adjusted rate's interval comes from `O_aar_CI=true`, sent whenever that rate is requested. Both are asked for explicitly rather than left to per-database defaults, and neither adds a cell.
- IDs are pinned, not resolved per call. `GET /controller/datarequest/<ID>` names the request page an ID belongs to and a retired ID names none — checked by `tests/services/wonder/database-ids.test.ts` under `WONDER_LIVE_TESTS=1`, which costs no rate-limited POST.
- Every relational input check — a reversed `year_range`, a repeated `group_by` dimension, `leading_causes` beside another dimension, a grouping whose value counts pass `WONDER_MAX_TABLE_ROWS`, per-database year spans, the `mcd_icd10`-needs-a-multiple-cause-database rule, the `999--999` marker off `provisional`, `NS` beside only some of the known `age_groups` (checked after deduplication) — is enforced **in the handler** before any request, never a Zod `refine`: a refinement adds nothing to the emitted JSON Schema and fails argument parsing as `invalid_arguments`, out of reach of the declared `invalid_query` recovery. Same pattern #27 established for `cdc_discover_datasets`. Union inputs (`age_groups`, both cause lists) are deduplicated in one normalization step that runs before `measuresFor`, the request builder, and `effectiveQuery` read them — a repeated age group otherwise reads as two and keeps an age-adjusted rate one group cannot support.
- `cause_icd10` / `mcd_icd10` take `string | string[]` (up to 50; `[]` reads as omitted, like `''`). Each entry is one `F_<ID>.V2` / `.V13` `<value>` — WONDER ORs values within a finder and ANDs the two finders — and `I_` carries them space-joined. WONDER accepts only nodes of its ICD-10 tree (chapter, block, code): `X40-X49` works, `X40-X44` is rejected as an invalid code, so a code set goes in as a list.
- Send a `Content-Type` and the server's own `User-Agent` (`USER_AGENT`, `src/services/user-agent.ts`), nothing else — a browser-looking User-Agent/Origin trips an upstream Akamai 403, and so does Node's default `fetch` client string; Socrata requests carry the same header.
- Each request carries a 20-second deadline over its headers and body (`REQUEST_DEADLINE_MS`, an `AbortController` on a `setTimeout`, not `fetchWithTimeout`, whose status-mapped errors would replace the service's own classification). Expiry is the retryable `upstream_error`; the caller's own abort rethrows as it arrived. A 429 is answered from its status before its body is read, so a stalled refusal cannot hold the lane.
- Hard 16-second gap between requests, enforced by the service (429 otherwise). It is measured from the end of the previous response, not from when its request was issued — WONDER rejects a request sent 15 s after the previous one started. The stamp lives in `send()`'s `finally`, so the network-error, 429, and malformed-body paths space the next call too. The limit is per source IP and shared across databases: one process-wide gap, never a per-database limiter. Overlapping calls queue in one process-wide lane — `query()` chains each call on the previous call's settlement (never its success) before it measures the gap, so concurrent calls go out one at a time instead of reading the same stamp and firing together. A call aborted while queued rejects at once and sends nothing; its lane slot still waits for the call ahead, and only a sent request stamps. A stalled request holds the lane for at most its deadline, so a call queued behind one settles within 20 + 16 + 20 seconds, inside the 60-second default request timeout of MCP SDK clients.
- National only; sub-national grouping and filtering are blocked by CDC policy.
- Every request must carry a rate measure — a deaths-only measure set is rejected.
- Cause of death is a filter (`cause_icd10`, `mcd_icd10`) and a grouping (`icd_chapter`, `icd_subchapter`, `cause_113`, `leading_causes`, `injury_intent`): WONDER attaches the full population and both rates to every cause row. Chapter and sub-chapter rows carry CDC's `cd` as `cause_code` (the form `cause_icd10` takes), `cause_113` rows carry its `h` as `cause_level` and nest, so deaths do not sum across levels. `leading_causes` beside any other dimension fails `invalid_query` in the handler (WONDER answers HTTP 500). `month` rows carry deaths only — CDC publishes no monthly population, so population and both rates are `Not Applicable`.
- A grouping is refused before any request when the product of the values its dimensions can take (`groupingValueCounts`) passes `WONDER_MAX_TABLE_ROWS`, 10,000: WONDER answers a larger table after the 20-second deadline, a retryable-looking failure no retry fixes. A coarser level grouped beside its finer one counts 1 — a `month` cell is a year-month and a sub-chapter lies inside one chapter, so `year` beside `month` and `icd_chapter` beside `icd_subchapter` add nothing. A cause filter lowers none of the counts. The bound equals the per-call row ceiling, so every table the handler accepts fits one page.
- Age-adjusted rate is rejected unless age can be standardized — omit it when `age_group` is a grouping dimension or the age-group filter selects exactly one group.
- Every input that mirrors a `V_*` option list carries the whole list — `age_groups` includes `NS`, and both cause filters accept `999--999` (the provisional database's withheld-cause marker, rejected by the other four in the handler) and `999-999`, the code a sub-chapter row carries for the same stratum, which is sent as `999--999`. The variables the tool still omits (everything `docs/design.md` lists as deliberately absent) are omitted by decision, not oversight; that doc holds the table and the reasoning.
- A measure cell may carry a status token instead of a number: `Suppressed`, `Unreliable`, `Not Applicable`. The parser nulls the value and records the token per cell. A rate cell nests its 95% interval as an `<l v="(lower - upper)"/>` child, which the parser reads into `<rate>_lower` and `<rate>_upper` — null where CDC sent none, and kept beside an `Unreliable` rate. When CDC flags a rate `Unreliable` depends on the database, as the caveat it attaches states: `D76` and `D77` when it is computed from 20 or fewer deaths, `D176`, `D158`, and `D157` when its 95% interval is wider than 160% of the rate, whatever the death count (`unreliableCriterion` in `WONDER_DATABASE_SPECS`). On every database the token replaces the rate; deaths and population stand.
- Caveat, footnote, and message anchors become Markdown links (`toLinkedText` in `xml-parser.ts`). Anchors are converted on the raw markup before any tag comes off, each segment is decoded once, and the assembled string is never decoded again. Hrefs resolve with `URL.parse(href, 'https://wonder.cdc.gov/')` and only an `http:`/`https:` result becomes a link — `URL` passes `javascript:` through — while a fragment-only or unparseable href keeps its text alone. `toPlainText` stays link-free for Socrata.
- Dimension labels come back as CDC's own text with surrounding whitespace trimmed (`dimensionLabel` in `xml-parser.ts`) — D158 and D157 pad their last year as `2024 `, which splits one year into two keys in a cross-database comparison. Nothing inside a label is touched: `2025 (provisional)` stays intact.
- Whole rows are hidden by default (zero deaths, suppressed deaths) and leave no trace in the table. WONDER says so in `<message>` elements on the 200, which `messages` carries verbatim, and the notice keys on which message CDC sent (`hiddenRowsKind`): "Rows with zero Deaths are hidden." alone means the stratum recorded none, so deaths summed from `rows` stay complete and an empty table reads as no deaths; a suppressed-deaths message, or one naming neither, reads as partial — the cautious default. `fixedParams()` deliberately does not send `O_show_zeros`/`O_show_suppressed` — unhiding changes the result set materially and needs its own design pass (rationale in `docs/design.md`).
- The provisional database's reporting lag gets two notices, both keyed on the years the query asked for, never on the rows returned or their `(provisional and partial)` label (`provisionalLagNotices` in `query-wonder.tool.ts`). The data-through year holds deaths only to the data-through date (`dataThrough`, read from the `<dataset>` vintage by `parseDataThrough`) against a full-year population, so its counts and rates read low; grouped by `month`, the notice also names the month that date falls in as partial, unless the date is the month's last day. And CDC counts V01-Y89, R95-R96 (and T36-T50 on the multiple-cause finder) deaths of the last 24 weeks under `999--999` until their cause is released, so a cause filter reaching them (`reachesLagWithheldCause`), or a cause grouping with no clear underlying-cause filter, runs low; the notice points at the `999--999` count as a bound on what one filter or cause row is missing, never a figure to add to it.

### Quirks

- SODA v2.1 response values are strings (numbers and dates included), and geo columns are GeoJSON objects — parse based on column type metadata.
- Dataset IDs are four-by-four format: `[a-z0-9]{4}-[a-z0-9]{4}` (e.g., `bi63-dtpu`).
- The catalog returns `chart`, `map`, `story`, `file`, and `href` assets alongside datasets, all with four-by-four IDs. **`columns.length === 0` from the metadata call is the queryability signal — not `resource.type` and not `viewType`.** A `filter` asset has real columns and queries fine; `chart` and `map` report `viewType: "tabular"` with zero columns.
- **Only `story`, `file`, and `href` ever 403.** `chart` and `map` answer `/resource/{id}.json` with HTTP 200 and a body of empty objects, so `cdc_query_dataset` resolves them against column metadata (`not_queryable`) rather than against a status — and the row shape alone can't decide it, since SODA omits null keys and a null-only projection on a real dataset serializes identically. The probe runs only when every returned row carries no fields, and passes `{ liveRowCount: false }` so it costs one request.
- **`cachedContents.count` is stale.** Socrata builds it once and never refreshes it (`4va6-ph5s`: 139,968 cached vs 218,700 live), and `filter` assets carry none. `getMetadata` fetches `count(*)` in parallel and discloses which figure it returned via `rowCountSource`. The count request carries `$select=count(*)` and nothing else — adding a real column changes what Socrata groups over and answers a different question. It is an annotation, never a dependency: it runs under `Promise.allSettled` with a 5s deadline of its own (`ROW_COUNT_TIMEOUT_MS`, shorter than the request deadline), so a failed or stalled count falls back to the cached figure instead of failing or hanging the metadata response. The caller's own cancellation is not a count failure: it rethrows rather than answering without the count.
- **Upstream descriptions are HTML.** `src/utils/text.ts` is the one conversion: tags off first (a linear scan that also drops a tag the catalog left cut open at the end), then entities decoded in a single left-to-right pass. Never chain per-entity replaces (`&amp;` first turns `&amp;lt;` into `<`), never reach for the framework's `sanitization.sanitizeString` (it re-escapes a bare `&`, and `sanitize-html` is an optional peer this server does not install), and never decode a numeric reference without a range check — `String.fromCodePoint` throws above U+10FFFF, and a lone surrogate passes Bun's JSON round-trip but makes `jq` reject the whole frame.
- `fetchJson` is shared by every Socrata definition and each handler re-dispatches on `err.data.reason` alone, so a reason must be true for every status it covers **and** declared by every consumer that can raise it — `ctx.fail` with an undeclared reason returns an `InternalError` that leaks the declared-reason list. `tests/services/socrata/socrata-contract-parity.test.ts` enforces both directions; the status→reason table lives in `docs/design.md`.
- **Every Socrata request has one `REQUEST_TIMEOUT_MS` (20 s) deadline over headers and body, and every failure to get a readable body is `upstream_error`:** a request that never reaches Socrata, a body cut off mid-transfer, a deadline expiry, a 2xx body that is not JSON, and JSON that fails the endpoint's body schema (an edge error page, `{"message":"ok"}`, which would otherwise read as an empty page). The caller's own cancellation rethrows as it arrived. The deepest tool calls chain two requests, so two deadlines and the spacing settle inside the 60-second default request timeout of MCP SDK clients. Publisher-labelled maps (`access_points`, `custom_fields`) are read off the parsed JSON by own-key lookups, not a Zod record, so a label of `__proto__` survives as a key.
- **Caller and upstream text in `content[]` is escaped at the render boundary, never in `structuredContent`** (`src/utils/markdown.ts`). Table cells go through `escapeTableCell` (Socrata column descriptions carry raw newlines, which terminate the row); other interpolations through `escapeMarkdownText` with the slot they sit in (`inline`, `line` for text opening its own line, `heading`); query echoes and field names through `markdownCodeSpan` / `markdownTableCodeSpan`; every Socrata `notice` through `markdownBlockquote` via `enrichmentTrailer.render`. GFM takes a bare URL's characters literally, so a scheme URL whose autolink run would take an escape renders as `<https://…>`; every other URL stays bare. WONDER caveats and messages stay unescaped — their links must stay live.
- **Dataset descriptions are cut with `truncatePlainText` (`src/utils/text.ts`) only, after `toPlainText`** — 300 characters in discovery, 4,000 on the schema tool and detail resource. It never leaves a partial URL to autolink, sets the `…` off from a URL with a space, and never splits a surrogate pair. Escape after the cut, in `format()`.
- The Discovery API unions `tags` — one parameter per value, matched against the catalog's own vocabulary case-insensitively. Adding a tag widens the result set, and a tag no dataset carries matches nothing and changes nothing. `query` and `category` intersect with it. Every surface naming tags says so: the input `.describe()`, the `appliedFilters` trailer, `README.md`, and `docs/design.md`.
- **`category` and `tags` are matched against controlled vocabularies, so a near miss is silence.** `Vaccinations` returns 89 entries, `Vaccination` returns 0 — same shape as a real value with no datasets. `cdc_list_catalog_vocabulary` publishes both vocabularies, and `cdc_discover_datasets`' empty-page notice resolves the filter against them via `matchVocabulary` (`src/utils/vocabulary.ts`, token containment in both directions — never fuzzy correction; a token under `MIN_CONTAINMENT_LENGTH` (3) letters or digits matches only an equal token, from the filter or from a value, so `tb` reaches the word `tb` in `tuberculosis (tb)` and never `outbreak`). Both filters match ignoring case. The lookup fires **only** from that branch: not for a non-empty page, not for a free-text-only search, not for an offset past the end. Its upstream failure is absorbed rather than failing the discovery response; the caller's own cancellation rethrows.
- **`ctx.enrich.notice` is last-wins**, and `ctx.enrich.truncated()` writes `notice` too. Both `cdc_discover_datasets` (empty-page text plus the relevance-order warning) and `cdc_query_dataset` accumulate guidance in a local array and flush exactly one writer — a second `notice` call silently destroys the first.
- `SocrataService.query` sends `$limit + 1` on the wire and drops the extra row — the SODA data endpoint reports no total, so the over-fetch is the only thing that separates a last page which fills the limit exactly from one that was cut. The echoed `query` is built **before** the probe overwrites `$limit`, so it stays the caller's own; handing back the probe value would give anyone replaying the echo one extra row per call. Socrata's parse errors quote the query it compiled, so `throwBadRequest` swaps the trailing `limit <limit + 1> offset <n>` of `data.query` back to the caller's limit in every copy the message quotes (an unexpected-character error quotes it twice) before relaying it. `tests/services/socrata/socrata-service.test.ts` and `socrata-service-errors.test.ts` pin both.
- **A blank or whitespace-only optional string is unset** (`nonBlank` in `src/utils/text.ts`): `SocrataService` omits it from every SoQL clause and catalog filter and drops blank `tags` entries, and both Socrata search tools normalize once at the top of the handler so echoes and notices agree. A value with text in it is sent byte-for-byte, surrounding whitespace included.
- **`:id` is a raw-rows tie-breaker only.** Socrata rejects it in ORDER BY once rows are grouped and answers it with HTTP 500 on a `distinct` select, so `cdc_query_dataset`'s resume advice appends the grouped columns or the selected columns there. Advice that adds a tie-breaker restarts the walk at `offset=0`: a page read without it is not a prefix of the tie-broken order, so continuing at `nextOffset` under the new order skips and repeats rows. A `column-not-in-group-bys` whose `data.position` caret sits in ORDER BY must never be answered with "add it to `group`" — that silently splits the aggregates.
- `QueryResult.query` (the `effectiveQuery` echo) is read back off `URLSearchParams` rather than decoded from its output — that form writes a space as `+` and a caller's literal `+` as `%2B`, so decoding it strands every space as a plus sign and swapping plus for space afterwards erases the arithmetic `+`.
- Year columns vary per dataset — some are numbers, some text. `where` clause must match the actual type.
- Some datasets suppress small counts for privacy (missing values or footnote markers, not zeros).
- No rate-limit headers returned — implement conservative request spacing (200-500ms).

### Server Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `CDC_APP_TOKEN` | No | — | Socrata app token for higher rate limits |
| `CDC_BASE_URL` | No | `https://data.cdc.gov` | SODA host for requests that name no `domain` — in practice only the `cdc://datasets/{datasetId}` resource. The four Socrata tools always send a `domain` (`data.cdc.gov` by default), which overrides this |
| `CDC_CATALOG_URL` | No | `https://api.us.socrata.com/api/catalog/v1` | Base URL for Socrata Discovery API requests — the catalog search behind `cdc_discover_datasets` and `cdc://datasets`, and the category and tag vocabularies behind `cdc_list_catalog_vocabulary` and the discovery near-miss notice |

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';

export const getDatasetSchema = tool('cdc_get_dataset_schema', {
  description: 'Fetch the full column schema for a CDC dataset.',
  annotations: { readOnlyHint: true },

  errors: [
    { reason: 'dataset_not_found', code: JsonRpcErrorCode.NotFound,
      when: 'Dataset ID does not exist or has been retired.',
      recovery: 'Search again with cdc_discover_datasets to find a current ID.' },
  ],

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

  // Different MCP clients read different surfaces — Claude Code reads
  // structuredContent, Claude Desktop reads content[]. format() is the
  // markdown twin of structuredContent and must carry the same data.
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
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  appToken: z.string().optional().describe('Socrata app token for higher rate limits'),
  baseUrl: z.string().url().default('https://data.cdc.gov').describe('Base URL for SODA API requests'),
  catalogUrl: z.string().url().default('https://api.us.socrata.com/api/catalog/v1').describe('Discovery API URL'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    appToken: 'CDC_APP_TOKEN',
    baseUrl: 'CDC_BASE_URL',
    catalogUrl: 'CDC_CATALOG_URL',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`CDC_APP_TOKEN`) rather than the internal path (`appToken`).

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.getMany(keys)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any JSON-serializable value; reads return its JSON form (a `Date` comes back as an ISO string). |
| `ctx.requestInput` | Suspend and ask the caller for more input — `return ctx.requestInput({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) } })`. Never returns; the handler is re-entered with the answers. Always present. |
| `ctx.inputs` | The request's responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped` — limited to what the client declared (`elicitation` and its form/url modes, `sampling`, `roots`). Client-supplied: a consent gate trusts only a `ctx.state` record it stored when it asked, bound to the operation, caller, and target (see the `api-context` skill). |
| `ctx.clientCapabilities` | What the client declared for this request, `undefined` when no view exists. Decides whether to ask for optional context (e.g. roots); never a reason to skip a consent prompt. |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.enrich` | Success-path enrichment — accumulates agent-facing context (notices, totals, query echo) onto the request. Reaches `structuredContent` + `content[]` automatically. Kind-tagged helpers: `.notice(text)`, `.total(n)`, `.echo(query)`, `.delta({ field, before, after })`. Always present; typed on `HandlerContext<R, E>` when an `enrichment` block is declared. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query.',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — per-tool repetition is the intended cost of locality. Don't extract a shared `errors[]` constant.

**Service-thrown errors** carry contract `reason` via `data: { reason }` on the factory call — services don't have `ctx.fail`. The auto-classifier preserves `data` so clients see the same shape.

**Fallback** for ad-hoc throws (no contract entry fits, prototype tools, service-layer code):

```ts
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, factory list, and contract reference.

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
    user-agent.ts                       # USER_AGENT sent to both upstreams
  utils/
    markdown.ts                         # escapeMarkdownText/escapeTableCell/code spans/blockquote — every format() and trailer render
    text.ts                             # toPlainText/decodeEntities/truncatePlainText — shared by Socrata + WONDER; nonBlank for blank inputs
    vocabulary.ts                       # matchVocabulary — catalog filter + near-miss notice
  mcp-server/
    tools/definitions/
      [tool-name].tool.ts               # Tool definitions
    resources/definitions/
      [resource-name].resource.ts       # Resource definitions
    prompts/definitions/
      [prompt-name].prompt.ts           # Prompt definitions
skills/
  cdc-health-guide/SKILL.md             # Published agent skill — served as skill://cdc-health-guide/SKILL.md
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

Two skill trees live at the project root, written for different readers:

| Tree | For | Written by |
|:-----|:----|:-----------|
| `framework-skills/` | The agent developing this server — framework skills (`metadata.audience: external`) plus any development-time skills of the server's own | `init` and the `maintenance` sync (framework skills); you (your own) |
| `skills/` | The agents that install the server and call its tools — tool chains, identifier sources, gates | You, deliberately, with the `add-skill` skill. Absent by default; usually none is needed |

Development skills are modular instructions. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. Their directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand them to every agent that installs it.

A published skill in root `skills/` reaches plugin installs and the `.mcpb` bundle as-is, ships in the npm package and the Docker image, and reaches MCP clients when the server opts in with `createApp({ skills: 'skills' })`. `lint:packaging` validates the tree.

This server publishes `skills/cdc-health-guide/SKILL.md` and opts in, so MCP clients also read it as `skill://cdc-health-guide/SKILL.md`. It carries the gates tool descriptions and `instructions` cannot: comparing groups on `age_adjusted_rate`, race beside Hispanic origin, comparing the provisional partial year month by month and ending withheld-cause series at the lag cutoff, year-month grouping and per-day peaks, splicing WONDER databases, and strata and missing values in long-format Socrata tables. When a tool's behavior changes, re-check the skill's claims against it; `field-test` verifies every gate and identifier claim live before a release.

**Agent skill directory:** Copy `framework-skills/` into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-skill` | Author a skill the server publishes in root `skills/` for the agents that use it — when one earns its place, structure, validation, delivery |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, parseEnvConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, typed error contracts, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity, `.mcpbignore` coverage, plugin manifests, the published `skills/` tree (run by devcheck) |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run list-skills` | Print the skill registry |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create GitHub Release from the current tag |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with Istanbul coverage |
| `bun run start` | Production mode (transport from `MCP_TRANSPORT_TYPE`) |
| `bun run start:stdio` | Production mode (stdio) — `bun run rebuild && bun run start:stdio` for dev smoke-tests |
| `bun run start:http` | Production mode (HTTP) — `bun run rebuild && bun run start:http` for dev smoke-tests |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. `mcpb pack` reads `.mcpbignore`, not `.gitignore`, so every root path the bundle must not ship — source, tests, docs, caches, logs, agent docs, plugin manifests, gitignored local files — needs a root-anchored line there (`/docs/`, never `docs/`, which also strips `node_modules/*/docs/`); `lint:packaging` names each missing or unanchored line. Root `skills/` ships on purpose. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips four classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/` at a package root, and `SKILL.md` — never the MCP SDK's `dist/ext/skills/` runtime); platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on; node-gyp build output beside a `binding.gyp` (`config.gypi`, Makefiles, `obj.target/`, `.deps/`, object files and debug symbols), which records the packing machine's paths — compiled `*.node` addons stay; and build-only package files — the framework's `changelog/`, `scripts/`, `templates/`, `CLAUDE.md`, `AGENTS.md`, and config bases (`biome.json`, `vitest.config.base.mjs`, `config/tsconfig.base.json`), and `better-sqlite3`'s `deps/` and `src/` C sources. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Delete `manifest.json` and `.mcpbignore` to skip; `lint:packaging` skips cleanly when `manifest.json` is absent.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.8.x/0.8.6.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.8.7 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the release digest: theme line, `## Changes`, `## Gates`, changelog link last); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, never a rewrite of pushed history and never a force-push, PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

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

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `plugin.json` + `mcp.json` (Agent Plugins 1.0.0 — read by Codex, Cursor, GitHub Copilot, VS Code, Kiro) populated — `plugin.json` `name` = the unscoped repo name (lowercase `a-z`, `0-9`, `-`, `.` only); `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords` from `package.json`; no other top-level field, `extensions` included. `mcp.json` holds one `"type": "stdio"` entry keyed by the unscoped name, `npx -y <full package name>`, and the same fixed `env` as `.codex-plugin/mcp.json`. Neither file carries a user-supplied variable (no `""`, no `${…}` besides `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`): keys reach Codex through `.codex-plugin/mcp.json` `env_vars`, which works only while `.codex-plugin/plugin.json` keeps `"mcpServers": "./.codex-plugin/mcp.json"`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] Any new root dev path has a root-anchored line in `.mcpbignore`; `bun run bundle` and `lint:packaging` pass
- [ ] If the server publishes a skill in root `skills/`: `lint:packaging` passes, and `field-test` verified every gate and identifier claim in it against live tool behavior
- [ ] `bun run devcheck` passes
