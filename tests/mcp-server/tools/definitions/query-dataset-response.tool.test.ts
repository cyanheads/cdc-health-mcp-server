/**
 * @fileoverview Whole-response tests for cdc_query_dataset: the delivered size of the complete
 * tool result (both surfaces) and the empty-page diagnosis, run through the real SocrataService
 * against a fetch fake so the budget and the offset probe are exercised end to end.
 * @module tests/mcp-server/tools/definitions/query-dataset-response
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';

const RESPONSE_BUDGET = 200_000;

type Row = Record<string, unknown>;

/** Serves `rows` as a SODA data endpoint would: honoring `$offset` and the wire `$limit`. */
function sodaEndpoint(rows: Row[] | ((params: URLSearchParams) => Row[] | Response)) {
  return (request: Request) => {
    const params = new URL(request.url).searchParams;
    if (typeof rows === 'function') {
      const out = rows(params);
      return out instanceof Response ? out : Response.json(out);
    }
    const offset = Number(params.get('$offset') ?? 0);
    const limit = Number(params.get('$limit') ?? 100);
    return Response.json(rows.slice(offset, offset + limit));
  };
}

/** A row roughly as wide as a 15-column surveillance record (~450 chars serialized). */
const surveillanceRow = (i: number): Row =>
  Object.fromEntries(
    Array.from({ length: 15 }, (_, c) => [`field_${c}`, `${i}-${'x'.repeat(18)}`]),
  );

const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('\n');

const structured = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.structuredContent as Record<string, unknown> & { rows: Row[]; rowCount: number };

describe('cdc_query_dataset — whole response', () => {
  const http = createFetchMock();

  beforeAll(() => {
    initSocrataService();
  });

  beforeEach(() => {
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  describe('response budget across both surfaces', () => {
    it('returns an ordinary page whole, rows on both surfaces', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), state: 'Texas' }));
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 20 });

      expect(structured(result).rows).toHaveLength(20);
      expect(structured(result).truncated).toBeUndefined();
      expect(text(result)).toContain('| 19 | Texas |');
    });

    it('keeps the complete serialized result within the stated budget at limit 5000', async () => {
      /**
       * Rows reach the caller twice — as JSON in structuredContent and as a markdown table in
       * content[] — so a budget counted over one serialization lets the response carry half
       * as much again as the stated figure.
       */
      const rows = Array.from({ length: 5001 }, (_, i) => surveillanceRow(i));
      http.route({ match: /\/resource\/4va6-ph5s\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: '4va6-ph5s', limit: 5000 });
      const sc = structured(result);

      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
      expect(sc.truncated).toBe(true);
      expect(sc.rowCount).toBeGreaterThan(0);
      expect(sc.shown).toBe(sc.rowCount);
      expect(sc.nextOffset).toBe(sc.rowCount);
      expect(sc.notice).toMatch(/200,000-character response budget/);
    });

    it('stays within the budget when later rows introduce columns earlier rows lack', async () => {
      /**
       * SODA omits null keys, so a column can first appear hundreds of rows in. Every earlier
       * row then gains an empty table cell, which a per-row cost that ignores the header would
       * never charge for.
       */
      const rows = Array.from({ length: 5001 }, (_, i) => {
        const row: Row = { id: String(i), value: 'v'.repeat(40) };
        for (let c = 0; c < 40; c++) if (i === 100 + c * 50) row[`late_column_${c}`] = 'z';
        if (i % 7 === 0) row.geo = { type: 'Point', coordinates: [-97.7, 30.2] };
        return row;
      });
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 5000 });
      const sc = structured(result);

      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
      expect(sc.truncated).toBe(true);
      const header = text(result)
        .split('\n')
        .find((line) => line.startsWith('| id'));
      expect(header).toContain('late_column_0');
    });

    it('charges each table line as rendered, Markdown escapes included', async () => {
      /**
       * Every character of these values is one `content[]` escapes, so each rendered table
       * line runs to about twice its raw length. A budget that charged the raw value while
       * the table carried the escaped one would ship well past the stated figure.
       */
      const rows = Array.from({ length: 5001 }, (_, i) => ({
        _id_: String(i),
        markup: '*_[]`\\<b>'.repeat(40),
      }));
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 5000 });
      const sc = structured(result);

      expect(sc.truncated).toBe(true);
      expect(text(result)).toContain(`| \\_id\\_ | markup |`);
      expect(text(result)).toContain(`| 0 | ${'\\*\\_\\[\\]\\`\\\\\\<b>'.repeat(40)} |`);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
    });

    it('charges each header key as rendered, Markdown escapes included', async () => {
      /**
       * A key appears once in the table header but in every row's JSON, so a wide escaped key on
       * the first row alone puts most of its cost in the header: `*` is one character raw,
       * three once escaped and JSON-encoded. Charged raw, the header under-counts by twice the
       * key's length and the small rows that follow fill the page past the budget.
       */
      const key = '*'.repeat(25_000);
      const rows = Array.from({ length: 5001 }, (_, i) =>
        i === 0 ? { id: '0', [key]: 'v' } : { id: String(i) },
      );
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 5000 });
      const sc = structured(result);

      expect(text(result)).toContain(`| id | ${'\\*'.repeat(25_000)} |`);
      expect(sc.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
    });

    it('charges the query echo as rendered in the trailer, code-span fence included', async () => {
      /**
       * The echo reaches structuredContent as a JSON string and the trailer as a code span
       * whose fence outgrows the longest backtick run inside it, so a backtick-heavy clause
       * costs far more rendered than raw; reserving the raw echo twice lets the rows run past
       * the budget.
       */
      const where = '`'.repeat(30_000);
      const rows = Array.from({ length: 5001 }, (_, i) => ({ id: String(i) }));
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, {
        datasetId: 'ab12-cd34',
        where,
        order: ':id',
        limit: 5000,
      });
      const sc = structured(result);

      expect(sc.effectiveQuery).toContain(`$where=${where}`);
      expect(text(result)).toContain('`'.repeat(30_001));
      expect(sc.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
    });

    it('resumes exactly at nextOffset across budget-cut pages', async () => {
      const rows = Array.from({ length: 5001 }, (_, i) => surveillanceRow(i));
      http.route({ match: /\/resource\/4va6-ph5s\.json/, respond: sodaEndpoint(rows) });

      const seen: string[] = [];
      let offset = 0;
      for (let page = 0; page < 3; page++) {
        const result = await runToolContract(queryDataset, {
          datasetId: '4va6-ph5s',
          limit: 5000,
          offset,
        });
        const sc = structured(result);
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
        seen.push(...sc.rows.map((r) => r.field_0 as string));
        offset = sc.nextOffset as number;
      }

      expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => `${i}-${'x'.repeat(18)}`));
    });

    it('charges the caller select the fieldless-rows notice quotes, as rendered', async () => {
      /**
       * The notice quotes `select` on both surfaces, escaped in content[] — every `*` is two
       * characters there and three once the text is a JSON string. Left uncharged, a long
       * select carried the response past the budget the rows were trimmed to.
       */
      const select = '*'.repeat(31_000);
      http.route({
        match: /\/api\/views\/ab12-cd34\.json/,
        respond: () => Response.json({ name: 'Real', columns: [{ fieldName: 'state' }] }),
      });
      http.route({
        match: /\/resource\/ab12-cd34\.json/,
        respond: sodaEndpoint(Array.from({ length: 5001 }, () => ({}))),
      });

      const result = await runToolContract(queryDataset, {
        datasetId: 'ab12-cd34',
        select,
        limit: 5000,
      });
      const sc = structured(result);

      expect(sc.notice).toContain(`the select clause "${select}"`);
      expect(sc.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESPONSE_BUDGET);
    });

    it('clamps limit past 5,000 to the cap on the wire and in the echo', async () => {
      const rows = Array.from({ length: 6000 }, (_, i) => ({ id: String(i) }));
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 6000 });
      const sc = structured(result);

      expect(new URL(http.calls[0]!.request.url).searchParams.get('$limit')).toBe('5001');
      expect(sc.effectiveQuery).toBe('$limit=5000&$offset=0');
      expect(sc.rows).toHaveLength(5000);
      expect(sc).toMatchObject({ truncated: true, shown: 5000, cap: 5000, nextOffset: 5000 });
      expect(text(result)).toContain('limit=6000 is above the 5,000 rows one call returns');
    });

    it('still returns a single row wider than the whole budget', async () => {
      http.route({
        match: /\/resource\/ab12-cd34\.json/,
        respond: sodaEndpoint([{ blob: 'x'.repeat(300_000) }, { blob: 'y' }]),
      });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 2 });
      const sc = structured(result);

      expect(sc.rows).toHaveLength(1);
      expect(sc.truncated).toBe(true);
      expect(sc.nextOffset).toBe(1);
    });
  });

  describe('whitespace-only clauses', () => {
    it('answers exactly as the omitted form does, on both surfaces and on the wire', async () => {
      /**
       * `select:" "` reached Socrata as `$select= `, which projects nothing: every row came
       * back fieldless, a metadata request was spent to explain it, and the notice blamed the
       * select clause " ".
       */
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint([{ state: 'Alabama', year: '2017' }]),
      });

      const blank = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        select: ' ',
        where: '   ',
        order: '\t',
        group: ' ',
        having: ' ',
        search: ' ',
        limit: 1,
      });
      const omitted = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', limit: 1 });

      expect(blank).toEqual(omitted);
      expect(structured(blank).effectiveQuery).toBe('$limit=1&$offset=0');
      expect(http.calls).toHaveLength(2);
      expect(http.calls[0]!.request.url).toBe(http.calls[1]!.request.url);
    });
  });

  describe('empty page diagnosis', () => {
    it('names an offset past the end when the same query has rows at offset 0', async () => {
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint(Array.from({ length: 50 }, (_, i) => ({ id: String(i) }))),
      });

      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        offset: 999_999,
      });
      const sc = structured(result);

      expect(sc.rows).toEqual([]);
      expect(sc.notice).toMatch(/past the end/i);
      expect(sc.notice).not.toMatch(/No rows matched|spelled/i);
      expect(text(result)).toMatch(/past the end/i);
      expect(text(result)).not.toMatch(/No rows matched|spelled/i);
      expect(sc.truncated).toBeUndefined();
      expect(sc.nextOffset).toBeUndefined();
      // The echo stays the caller's own query, never the probe's.
      expect(sc.effectiveQuery).toBe('$limit=100&$offset=999999');

      expect(http.calls).toHaveLength(2);
      const probe = new URL(http.calls[1]!.request.url).searchParams;
      expect(probe.get('$offset')).toBe('0');
      expect(probe.get('$limit')).toBe('2');
    });

    it('counts in the singular when the offset past the end is 1', async () => {
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint([{ id: '0' }]),
      });

      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', offset: 1 });
      const sc = structured(result);

      expect(sc.notice).toContain('the result set holds 1 row or fewer');
      expect(sc.notice).not.toContain('1 rows');
      expect(text(result)).toContain('the result set holds 1 row or fewer');
    });

    it('counts in the plural for any larger offset past the end', async () => {
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint([{ id: '0' }]),
      });

      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', offset: 2 });

      expect(structured(result).notice).toContain('the result set holds 2 rows or fewer');
    });

    it('carries the caller filters into the probe so it asks the same question', async () => {
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint((params) =>
          params.get('$offset') === '0' ? [{ state: 'Texas' }] : [],
        ),
      });

      await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        where: "state='Texas'",
        search: 'suicide',
        order: ':id',
        offset: 500,
      });

      const probe = new URL(http.calls[1]!.request.url).searchParams;
      expect(probe.get('$where')).toBe("state='Texas'");
      expect(probe.get('$q')).toBe('suicide');
      expect(probe.get('$offset')).toBe('0');
    });

    it('keeps the no-match guidance when the query is empty at offset 0 as well', async () => {
      http.route({ match: /\/resource\/bi63-dtpu\.json/, respond: sodaEndpoint([]) });

      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        where: "state='Atlantis'",
        offset: 50,
      });
      const sc = structured(result);

      expect(sc.notice).toContain('No rows matched');
      expect(sc.notice).not.toMatch(/past the end/i);
      expect(text(result)).toContain('No rows matched');
      expect(http.calls).toHaveLength(2);
    });

    it('spends no probe on an empty page at offset 0', async () => {
      http.route({ match: /\/resource\/bi63-dtpu\.json/, respond: sodaEndpoint([]) });

      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        where: "state='Atlantis'",
      });

      expect(structured(result).notice).toContain('No rows matched');
      expect(http.calls).toHaveLength(1);
    });

    it('spends no probe on a non-empty page at offset > 0', async () => {
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint(Array.from({ length: 50 }, (_, i) => ({ id: String(i) }))),
      });

      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu', offset: 40 });

      expect(structured(result).rows).toHaveLength(10);
      expect(http.calls).toHaveLength(1);
    });

    it('names both causes rather than failing when the probe itself fails', async () => {
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: sodaEndpoint((params) =>
          params.get('$offset') === '0' ? new Response('upstream down', { status: 503 }) : [],
        ),
      });

      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        offset: 999_999,
      });
      const sc = structured(result);

      expect(result.isError).toBeFalsy();
      expect(sc.rows).toEqual([]);
      expect(sc.notice).toMatch(/past the end/i);
      expect(sc.notice).toMatch(/matches nothing|matched nothing/i);
      expect(text(result)).toMatch(/past the end/i);
      expect(http.calls).toHaveLength(2);
    });
  });
});
