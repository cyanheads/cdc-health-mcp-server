/**
 * @fileoverview Tool to execute SoQL queries against any CDC dataset.
 * @module mcp-server/tools/definitions/query-dataset
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getSocrataService } from '@/services/socrata/socrata-service.js';
import {
  CDC_SOCRATA_DOMAINS,
  type DatasetMetadata,
  type QueryResult,
} from '@/services/socrata/types.js';
import { escapeTableCell, markdownBlockquote, markdownCodeSpan } from '@/utils/markdown.js';
import { jsonLength, MAX_RESPONSE_CHARS } from '@/utils/response-budget.js';
import { nonBlank } from '@/utils/text.js';

/**
 * Most rows one call returns. `limit` sizes the SODA `$limit`, so it is a workload cap: a larger
 * `limit` is clamped to it and the clamp disclosed, rather than the call rejected.
 */
const MAX_LIMIT = 5000;
const MAX_LIMIT_TEXT = MAX_LIMIT.toLocaleString('en-US');
/**
 * Ceiling on `offset`, mirrored in the input schema and used to decide whether a
 * `nextOffset` the caller could not actually replay is worth emitting. Also the ceiling on
 * `limit`: a page sized past it reaches rows no offset can page to.
 */
const MAX_OFFSET = 1_000_000;
const MAX_OFFSET_TEXT = MAX_OFFSET.toLocaleString('en-US');
/**
 * Characters held back from the `MAX_RESPONSE_CHARS` row budget for the parts of the response
 * that are not rows: the result keys, the row-count heading, the table's opening pipes, the
 * schema tip, the enrichment trailer's labels, and the notice, which reaches both surfaces.
 * The fixed text of the longest notice combination, doubled, is under 2,000 characters; the
 * query echo and the caller's clauses a notice quotes are reserved separately because their
 * length is the caller's.
 *
 * Every row reaches the caller twice: as JSON in `structuredContent` and as a line of the
 * markdown table in `content[]`, so each row is charged both costs. A row count is a leaky
 * proxy for size: 5,000 rows of a 38-column surveillance dataset serialize to ~6 MB, while
 * 5,000 rows of a 3-column summary fit in a fraction of that. The budget only ever shortens a
 * page below its (capped) `limit`, and rows it drops are disclosed with a `nextOffset` that
 * resumes exactly where the response stopped.
 */
const FRAMING_RESERVE = 4_000;

type Row = Record<string, unknown>;

/** One table cell, as `format()` renders it — shared so the budget charges what is rendered. */
function renderCell(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return escapeTableCell(text);
}

/** One table line over `columns`, with an empty cell for each column the row omits. */
function renderTableRow(row: Row, columns: readonly string[]): string {
  return `| ${columns.map((column) => renderCell(row[column])).join(' | ')} |`;
}

/**
 * The trailer line for the query echo — a code span, since a SoQL clause is full of characters
 * Markdown acts on (`count(*)` alone pairs into emphasis). Shared with the budget so the echo
 * is charged as rendered.
 */
function renderEffectiveQuery(query: string): string {
  return `**effectiveQuery:** ${markdownCodeSpan(query)}`;
}

/**
 * Take rows from the head of the page until the next one would carry the serialized response
 * past `MAX_RESPONSE_CHARS`. A row costs its JSON plus its table line; a column first seen on
 * a later row also costs its header and separator cells and one empty cell on every earlier
 * line, since SODA omits null keys and the table is headed by the union of all rows' keys.
 * Always keeps the first row: a single row wider than the whole budget still has to come back
 * as a row, not as an empty page that reads like "nothing matched".
 */
function withinBudget(rows: Row[], reserved: number): Row[] {
  let used = reserved;
  const columns: string[] = [];
  const known = new Set<string>();
  for (const [index, row] of rows.entries()) {
    for (const key of Object.keys(row)) {
      if (known.has(key)) continue;
      known.add(key);
      columns.push(key);
      used += jsonLength(renderCell(key)) + ' | '.length + ' | ---'.length + ' | '.length * index;
    }
    // The row inside the JSON array plus its comma, then its table line plus the newline.
    used += JSON.stringify(row).length + 1 + jsonLength(`${renderTableRow(row, columns)}\n`);
    if (used > MAX_RESPONSE_CHARS) return rows.slice(0, Math.max(index, 1));
  }
  return rows;
}

/** What `text` costs in the response: a JSON string in `structuredContent`, a blockquote in `content[]`. */
function noticeCost(text: string): number {
  return jsonLength(text) + jsonLength(markdownBlockquote(text));
}

/**
 * Split a SoQL list clause — a `group`, an `order`, a select list — at its top-level commas,
 * never at one inside parentheses or a quoted literal or identifier. One pass over the clause.
 */
function splitTopLevel(clause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < clause.length; i++) {
    const char = clause[i];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(depth - 1, 0);
    } else if (char === ',' && depth === 0) {
      parts.push(clause.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(clause.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Trailing ORDER BY words that set direction or null placement, not what is sorted on. */
const SORT_MODIFIERS = new Set(['asc', 'desc', 'null', 'nulls', 'first', 'last']);

/** The expression an ORDER BY term sorts on, case- and spacing-normalized for comparison. */
function sortKey(term: string): string {
  const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && SORT_MODIFIERS.has(tokens.at(-1) ?? '')) tokens.pop();
  return tokens.join(' ');
}

/**
 * The columns of a `distinct` select, each as the names an order can reach it by — its alias
 * first, when it has one, then its expression. `undefined` for any other select.
 */
function distinctColumns(select: string | undefined): string[][] | undefined {
  const list = select?.trimStart();
  if (!list || !/^distinct\s/i.test(list)) return;
  return splitTopLevel(list.slice('distinct'.length)).map((item) => {
    const tokens = item.split(/\s+/);
    const alias = tokens.length >= 3 && tokens.at(-2)?.toLowerCase() === 'as' ? tokens.at(-1) : '';
    return alias ? [alias, tokens.slice(0, -2).join(' ')] : [item];
  });
}

const TIE_BREAK_REASON = {
  raw: '":id" is the row identifier every dataset carries',
  grouped: 'The grouped columns identify each row of a grouped result',
  distinct: 'The selected columns identify each row of a distinct select',
} as const;

/**
 * How to page on past this page with an order that makes the walk gap-free — the caller's own
 * order, kept as written, with the tie-breaker the query's shape admits appended. That is the
 * grouped columns of a grouped query and the selected columns of a distinct select, since
 * Socrata rejects `:id` once rows are grouped and answers it with HTTP 500 on a distinct
 * select; on raw rows it is `:id`. A tie-breaker the order already carries is not repeated.
 *
 * When the order already carries it, the walk continues at `nextOffset` under the same order.
 * When the tie-breaker has to be added, the walk restarts at offset 0: this page was read
 * under an order that leaves ties in no fixed sequence, so it need not be a prefix of the
 * tie-broken order, and continuing at `nextOffset` under that order skips and repeats rows.
 * Advice only: the request's own `order` is never rewritten, and `nextOffset` stays the next
 * offset under it.
 */
function resumeAdvice(
  nextOffset: number,
  clauses: { group?: string | undefined; order?: string | undefined; select?: string | undefined },
): string {
  const distinct = clauses.group ? undefined : distinctColumns(clauses.select);
  const [shape, keys]: [keyof typeof TIE_BREAK_REASON, string[][]] = clauses.group
    ? ['grouped', splitTopLevel(clauses.group).map((column) => [column])]
    : distinct
      ? ['distinct', distinct]
      : ['raw', [[':id']]];

  const order = clauses.order?.trim();
  const present = new Set(order ? splitTopLevel(order).map(sortKey) : []);
  const additions = keys
    .filter((names) => !names.some((name) => present.has(sortKey(name))))
    .map(([name]) => name);

  if (order && additions.length === 0) {
    return `Call again with offset=${nextOffset} and the same order="${order}" to continue.`;
  }
  const suggested = [order, ...additions].filter(Boolean).join(', ');
  return `To page on without skipping or repeating rows, call again from offset=0 with order="${suggested}" and continue by offset from there. ${TIE_BREAK_REASON[shape]}, and this page was read without that tie-breaker, so the rows returned so far need not be the ones that order puts first.`;
}

const NO_MATCH_NOTICE =
  'No rows matched the query. Verify string values are spelled exactly as stored (check with a GROUP BY enumeration), confirm numeric/date filters match the column type from the schema, or broaden the WHERE clause.';

export const queryDataset = tool('cdc_query_dataset', {
  description:
    'Execute a SoQL query against any CDC dataset. Supports filtering, aggregation, sorting, full-text search, and field selection. Use cdc_discover_datasets to find dataset IDs and cdc_get_dataset_schema to inspect columns before querying.',
  annotations: { readOnlyHint: true },

  errors: [
    {
      reason: 'dataset_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Dataset ID does not exist or has been retired.',
      recovery:
        'Search again with cdc_discover_datasets to find a current ID for the topic of interest.',
    },
    {
      reason: 'no_such_column',
      code: JsonRpcErrorCode.ValidationError,
      when: 'WHERE/SELECT/GROUP/ORDER references a column that does not exist on this dataset.',
      recovery:
        'Call cdc_get_dataset_schema for this dataset and rewrite the query using actual column names.',
    },
    {
      reason: 'type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Filter value type does not match the column data type (e.g., quoting a number).',
      recovery:
        'Inspect column types via cdc_get_dataset_schema and adjust filter literals to match (numbers unquoted, strings single-quoted).',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Socrata rejected the SoQL query for other syntax or semantic reasons.',
      recovery:
        'Read the error message for the specific clause and consult the dataset schema before retrying.',
    },
    {
      reason: 'not_queryable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The ID names a non-tabular asset: the data endpoint answered with rows carrying no fields, and the asset reports no columns.',
      recovery:
        'Pick an ID from cdc_discover_datasets whose columnCount is above zero; those are the entries cdc_query_dataset can read.',
    },
    {
      reason: 'access_denied',
      code: JsonRpcErrorCode.Forbidden,
      when: 'Socrata returned 403 — typically an ID naming a story, file, or external link rather than a tabular dataset.',
      recovery:
        'Confirm the ID with cdc_get_dataset_schema, then query one whose schema lists columns; retrying this ID returns the same refusal.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Socrata API returns 429 Too Many Requests.',
      retryable: true,
      recovery: 'Retry after a brief delay; the request was rate-limited.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Socrata data API returned a 5xx server error.',
      retryable: true,
      recovery: 'Retry after a brief delay; data.cdc.gov may be temporarily unavailable.',
    },
  ],

  input: z.object({
    domain: z
      .enum(CDC_SOCRATA_DOMAINS)
      .default('data.cdc.gov')
      .describe(
        'CDC Socrata host to query. "data.cdc.gov" (default) and "chronicdata.cdc.gov" front the same catalog, so a four-by-four ID returns the same rows from either and the default works whichever host the dataset was found on.',
      ),
    datasetId: z
      .string()
      .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
      .describe(
        'Four-by-four dataset identifier (e.g., "bi63-dtpu"). Obtain from cdc_discover_datasets.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Full-text search across all text columns. For precise filtering use the where parameter instead.',
      ),
    select: z
      .string()
      .optional()
      .describe(
        'SoQL SELECT clause — column names, aliases, or aggregates: "state, sum(deaths) as total_deaths". Omit for all columns. To enumerate distinct values of a column, set select to "{column}, count(*) as count" with group="{column}" and order="count DESC, {column}".',
      ),
    where: z
      .string()
      .optional()
      .describe(
        'SoQL WHERE clause. Strings must be single-quoted: "state=\'California\' AND year=2020". If a column name matches a SoQL keyword (group, select, where, order, limit, offset, having, search), wrap it in backticks: "`group`=\'By Year\'".',
      ),
    group: z
      .string()
      .optional()
      .describe('SoQL GROUP BY clause. Requires aggregate functions in select.'),
    having: z.string().optional().describe('SoQL HAVING clause. Filters aggregated results.'),
    order: z
      .string()
      .optional()
      .describe(
        'SoQL ORDER BY clause. Field name with optional ASC/DESC: "total_deaths DESC". Set one from the first page whenever paging with offset, and keep it for the whole walk: SODA does not order results implicitly, so consecutive offsets without a deterministic order, or under a changed one, can skip or repeat rows. End it with a tie-breaker unique to each row: on ungrouped rows, the system field `:id`, present on every dataset (order="year DESC, :id"); on a grouped query, the grouped columns (order="total DESC, state"); on a distinct select, the selected columns. Socrata rejects `:id` once rows are grouped.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_OFFSET)
      .default(100)
      .describe(
        `Max rows to return (default 100). One call returns at most ${MAX_LIMIT_TEXT} rows: a larger limit, up to ${MAX_OFFSET_TEXT}, is capped at ${MAX_LIMIT_TEXT}, and the response says so and gives a nextOffset when more rows remain. Fewer come back when the page would carry the response past its ${MAX_RESPONSE_CHARS.toLocaleString('en-US')}-character budget, counted over the whole result — the rows as JSON and as the rendered table together; the response says so and gives a nextOffset to resume from.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(MAX_OFFSET)
      .default(0)
      .describe(
        'Row offset for pagination (max 1,000,000). Pair with a deterministic order clause — an offset walk over unordered results can skip or repeat rows.',
      ),
  }),

  output: z.object({
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Result rows with requested fields. Most values are strings (including numbers/dates); geo columns return GeoJSON objects.',
      ),
    rowCount: z.number().describe('Number of rows returned in this response.'),
  }),

  // Agent-facing result-set context: the assembled SoQL query sent to Socrata (for
  // debugging and reproducibility), capped-list disclosure, and a recovery notice when
  // nothing matched. Reaches structuredContent AND content[] automatically — no format() entry.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe(
        'The SoQL clauses sent to Socrata, as `$clause=value` pairs joined by "&". Values read exactly as they were supplied — not URL-encoded — so a clause can be copied back into the matching parameter of another call.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when rows exist beyond the ones returned, established by fetching one row more than the limit rather than inferred from the row count. Absent means this response is the complete remainder of the result set.',
      ),
    shown: z.number().optional().describe('Number of rows returned in this response.'),
    cap: z
      .number()
      .optional()
      .describe(
        `The row limit that bounded this response: the requested limit, or ${MAX_LIMIT_TEXT} when a larger one was capped.`,
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call, under the same order, to resume immediately after the last row returned. Present only when further rows exist and the resume point is within the offset ceiling. The walk is gap-free only when that order ends in a tie-breaker unique to each row; when it does not, the notice says to restart from offset 0 with one.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance when no rows matched, when offset ran past the end of the result set, when further rows remain (naming a limit above ${MAX_LIMIT_TEXT} that was capped), or when the response budget cut the page short — how to verify filters, lower offset, resume paging under the same order or restart it from offset 0 under one that makes the walk gap-free, or broaden the query.`,
      ),
  },

  // The echo and the notice both quote the caller's own clauses, so neither may reach
  // content[] as live Markdown.
  enrichmentTrailer: {
    effectiveQuery: { render: renderEffectiveQuery },
    notice: { render: markdownBlockquote },
  },

  async handler(input, ctx) {
    const service = getSocrataService();

    /**
     * Re-raise a service failure through this tool's contract so it reaches the caller with
     * the declared reason and recovery instead of an unclassified upstream error.
     */
    const asContractError = (err: unknown): unknown => {
      if (err instanceof McpError && typeof err.data?.reason === 'string') {
        const reason = err.data.reason as Parameters<typeof ctx.fail>[0];
        return ctx.fail(reason, err.message);
      }
      return err;
    };

    /**
     * A whitespace-only clause is unset, as a blank one already was: it reaches neither the
     * request nor any notice that quotes the caller. `limit` past the cap is clamped here and
     * disclosed below rather than rejected.
     */
    const limit = Math.min(input.limit, MAX_LIMIT);
    const clauses = {
      ...input,
      limit,
      search: nonBlank(input.search),
      select: nonBlank(input.select),
      where: nonBlank(input.where),
      group: nonBlank(input.group),
      having: nonBlank(input.having),
      order: nonBlank(input.order),
    };

    let result: QueryResult;
    try {
      result = await service.query(clauses, ctx.signal);
    } catch (err) {
      throw asContractError(err);
    }

    ctx.enrich({ effectiveQuery: result.query });

    const projection = clauses.select
      ? `the select clause "${clauses.select}"`
      : 'every column of the dataset';

    /**
     * The query echo reaches both surfaces — structuredContent and the enrichment trailer — and
     * so does every notice. A notice's fixed text sits in `FRAMING_RESERVE`; the caller's
     * clauses it quotes are charged here, as rendered, wherever that notice can appear: the
     * resume advice on any non-empty page (the budget itself may cut it), the projection when
     * the first row — which the budget always keeps — carries no fields.
     */
    const [firstRow] = result.rows;
    const reserved =
      FRAMING_RESERVE +
      jsonLength(result.query) +
      jsonLength(renderEffectiveQuery(result.query)) +
      (firstRow ? noticeCost(resumeAdvice(MAX_OFFSET, clauses)) : 0) +
      (firstRow && Object.keys(firstRow).length === 0 ? noticeCost(projection) : 0);
    const rows = withinBudget(result.rows, reserved);
    const budgetCut = rows.length < result.rows.length;
    const hasMore = result.hasMore || budgetCut;
    const nextOffset = input.offset + rows.length;

    /**
     * `enrich.notice` is last-wins, and `enrich.truncated()` writes `notice` too. The
     * fieldless-rows notice and the truncation notice can both apply to one response, so the
     * guidance accumulates here and is flushed once rather than one call overwriting another.
     */
    const guidance: string[] = [];

    if (result.rows.length === 0 && input.offset === 0) {
      guidance.push(NO_MATCH_NOTICE);
    } else if (result.rows.length === 0) {
      /**
       * The data endpoint reports no total, so an offset paged past the end of a real result
       * set and a filter that matched nothing arrive identically. The same query at offset 0
       * tells them apart for one row's cost, spent only on this branch — an empty page at
       * offset 0 and every non-empty page issue no extra request. The probe annotates an
       * answer that is already correct, so its failure names both causes rather than failing
       * the call.
       */
      let matchedAtStart: boolean | undefined;
      try {
        const probe = await service.query({ ...clauses, offset: 0, limit: 1 }, ctx.signal);
        matchedAtStart = probe.rows.length > 0;
      } catch (err) {
        ctx.log.warning('Offset probe failed; empty page left undiagnosed', {
          datasetId: input.datasetId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (matchedAtStart === true) {
        guidance.push(
          `Offset ${input.offset} is past the end of the result set. The same query returns rows from offset 0, so it matched — the result set holds ${input.offset} row${input.offset === 1 ? '' : 's'} or fewer. Lower offset to page within it.`,
        );
      } else if (matchedAtStart === false) {
        guidance.push(NO_MATCH_NOTICE);
      } else {
        guidance.push(
          `No rows came back at offset ${input.offset}. Either the offset is past the end of the result set or the query matches nothing — the check at offset 0 that separates the two could not be completed. Call again with offset=0: rows there mean the offset ran past the end; none means the filters need checking against the schema and the stored values.`,
        );
      }
    } else if (rows.every((row) => Object.keys(row).length === 0)) {
      /**
       * Socrata answers a chart or map ID with HTTP 200 and a body of empty objects, which is
       * a paginated success as far as the row shape goes. The shape cannot decide it either
       * way: SODA omits null keys, so a real dataset whose projected columns are null on the
       * matched rows serializes identically. Only the asset's column metadata separates them,
       * which is why this one request is spent here and on no other path.
       */
      let metadata: DatasetMetadata;
      try {
        metadata = await service.getMetadata(input.datasetId, ctx.signal, input.domain, {
          liveRowCount: false,
        });
      } catch (err) {
        throw asContractError(err);
      }

      if (metadata.columns.length === 0) {
        throw ctx.fail(
          'not_queryable',
          `Dataset ${input.datasetId} ("${metadata.name}") has no columns. The ID names a non-tabular catalog asset — a chart or a map — and the rows it returned carry no fields, so there is no data to page through.`,
        );
      }

      const datasetColumns =
        metadata.columns.length === 1
          ? '1 column — check it'
          : `${metadata.columns.length.toLocaleString('en-US')} columns — check them`;
      guidance.push(
        `Every row came back with no fields: ${projection} is null on ${rows.length === 1 ? 'the 1 matched row' : `all ${rows.length.toLocaleString('en-US')} matched rows`}, and Socrata omits null keys from its JSON rather than sending them as nulls. The dataset itself has ${datasetColumns} with cdc_get_dataset_schema and select ones the matched rows populate, or widen the where clause.`,
      );
    }

    if (result.rows.length > 0 && hasMore) {
      const clamped = input.limit > MAX_LIMIT;
      const capNote = clamped
        ? ` (limit=${input.limit} is capped at ${MAX_LIMIT_TEXT} rows per call)`
        : '';
      const cause = budgetCut
        ? `the ${MAX_RESPONSE_CHARS.toLocaleString('en-US')}-character response budget, which counts the rows as JSON and as the rendered table together, cut the page at ${rows.length.toLocaleString('en-US')} of the ${limit.toLocaleString('en-US')} rows requested${capNote}`
        : clamped
          ? `limit=${input.limit} is above the ${MAX_LIMIT_TEXT} rows one call returns, so the page stopped at ${MAX_LIMIT_TEXT}`
          : `the requested limit of ${input.limit} was reached`;
      const resume =
        nextOffset <= MAX_OFFSET
          ? resumeAdvice(nextOffset, clauses)
          : `Resuming would need offset=${nextOffset}, past the ${MAX_OFFSET_TEXT} ceiling this tool accepts — narrow the query with a where clause instead of paging further.`;
      ctx.enrich.truncated({ shown: rows.length, cap: limit });
      guidance.push(`More rows exist beyond this response — ${cause}. ${resume}`);
      if (nextOffset <= MAX_OFFSET) ctx.enrich({ nextOffset });
    }

    if (guidance.length > 0) ctx.enrich.notice(guidance.join(' '));

    ctx.log.info('Query executed', {
      domain: input.domain,
      datasetId: input.datasetId,
      rowCount: rows.length,
      budgetCut,
      hasMore,
      query: result.query,
    });

    return { rows, rowCount: rows.length };
  },

  format: (result) => {
    if (!result.rows[0]) {
      /**
       * An empty page has three possible causes — filters that match nothing, an offset past
       * the end, or a diagnosis the probe could not complete — and only the handler knows
       * which. The notice names it and reaches `content[]` through the enrichment trailer, so
       * this line stays neutral rather than asserting a cause the notice may contradict.
       */
      return [{ type: 'text', text: '**0 rows returned**' }];
    }

    // Socrata rows are sparse: fields selected by the caller can be omitted on early
    // rows and appear only later. Build the column set from the union of keys across
    // all rows (first-seen order) so late-appearing fields still render in content[].
    const columns = [...new Set(result.rows.flatMap((r) => Object.keys(r)))];

    if (columns.length === 0) {
      /**
       * Rows matched but the projection is null on every one of them, so there is no column
       * to head a table with. Rendered as one anyway it is a header of nothing over rows of
       * nothing — the same meaningless table to a client that reads only this surface. The
       * notice carrying the next move is already its own block in `content[]`.
       */
      return [
        {
          type: 'text',
          text: `**${result.rowCount} rows matched, and every one came back with no fields.** The selected columns are null on all of them, so there is nothing to tabulate.`,
        },
      ];
    }

    const lines = [
      `**${result.rowCount} rows returned**`,
      '',
      // SoQL accepts aliases such as `_x_`, which render as emphasis left bare.
      `| ${columns.map(renderCell).join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
    ];

    for (const row of result.rows) lines.push(renderTableRow(row, columns));

    lines.push(
      '',
      'Tip: Use cdc_get_dataset_schema to inspect column names and types if filter results are unexpected.',
    );

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
