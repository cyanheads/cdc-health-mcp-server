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
