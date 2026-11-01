/**
 * @fileoverview Whole-response tests for cdc_query_dataset: the page `limit` sets on both
 * surfaces, its 1,000-row ceiling, and the empty-page diagnosis, run through the real
 * SocrataService against a fetch fake so the over-fetch probe and the offset probe are
 * exercised end to end.
 * @module tests/mcp-server/tools/definitions/query-dataset-response
 */

import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';
import { contentText as text } from '../../../helpers/contract-text.js';

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

  describe('limit is the page, on both surfaces', () => {
    /** Data rows of the content[] table — every line after the header and its separator. */
    const tableRows = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      text(result)
        .split('\n')
        .filter((line) => line.startsWith('| '))
        .slice(2);

    it('returns an ordinary page whole, rows on both surfaces', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), state: 'Texas' }));
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 20 });

      expect(structured(result).rows).toHaveLength(20);
      expect(structured(result).truncated).toBeUndefined();
      expect(text(result)).toContain('| 19 | Texas |');
    });

    it('returns a full 1,000-row page of wide rows, the over-fetch deciding truncation', async () => {
      const rows = Array.from({ length: 2500 }, (_, i) => surveillanceRow(i));
      http.route({ match: /\/resource\/akvg-8vrb\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'akvg-8vrb', limit: 1000 });
      const sc = structured(result);

      expect(new URL(http.calls[0]!.request.url).searchParams.get('$limit')).toBe('1001');
      expect(sc.rows).toHaveLength(1000);
      expect(sc.rowCount).toBe(1000);
      expect(tableRows(result)).toHaveLength(1000);
      expect(sc).toMatchObject({ truncated: true, shown: 1000, cap: 1000, nextOffset: 1000 });
      expect(sc.notice).toContain('the requested limit of 1000 was reached');
      expect(sc.notice).not.toMatch(/budget|character/);
    });

    it.each([1001, 5000, 1_000_000])(
      'clamps limit %i to 1,000 on the wire and in the echo, and names the clamp',
      async (limit) => {
        const rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i) }));
        http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

        const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit });
        const sc = structured(result);

        expect(new URL(http.calls[0]!.request.url).searchParams.get('$limit')).toBe('1001');
        expect(sc.effectiveQuery).toBe('$limit=1000&$offset=0');
        expect(sc.rows).toHaveLength(1000);
        expect(sc).toMatchObject({ truncated: true, shown: 1000, cap: 1000, nextOffset: 1000 });
        expect(sc.notice).toContain(
          `limit=${limit} is above the 1,000 rows one call returns, so the page stopped at 1,000`,
        );
        expect(text(result)).toContain(`limit=${limit} is above the 1,000 rows one call returns`);
      },
    );

    it('returns a result shorter than limit whole, with no truncation', async () => {
      const rows = Array.from({ length: 750 }, (_, i) => surveillanceRow(i));
      http.route({ match: /\/resource\/akvg-8vrb\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'akvg-8vrb', limit: 1000 });
      const sc = structured(result);

      expect(sc.rows).toHaveLength(750);
      expect(tableRows(result)).toHaveLength(750);
      for (const key of ['truncated', 'shown', 'cap', 'nextOffset', 'notice']) {
        expect(sc).not.toHaveProperty(key);
      }
    });

    it('returns a last page that fills limit exactly with no truncation', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
      http.route({ match: /\/resource\/ab12-cd34\.json/, respond: sodaEndpoint(rows) });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 1000 });

      expect(structured(result).rows).toHaveLength(1000);
      expect(structured(result).truncated).toBeUndefined();
    });

    it('walks a result set to its end at nextOffset, every row once', async () => {
      const rows = Array.from({ length: 2500 }, (_, i) => surveillanceRow(i));
      http.route({ match: /\/resource\/4va6-ph5s\.json/, respond: sodaEndpoint(rows) });

      const seen: string[] = [];
      let offset: number | undefined = 0;
      const pages: number[] = [];
      while (offset !== undefined) {
        const result = await runToolContract(queryDataset, {
          datasetId: '4va6-ph5s',
          order: ':id',
          limit: 1000,
          offset,
        });
        const sc = structured(result);
        pages.push(sc.rows.length);
        seen.push(...sc.rows.map((r) => r.field_0 as string));
        offset = sc.nextOffset as number | undefined;
      }

      expect(pages).toEqual([1000, 1000, 500]);
      expect(seen).toEqual(rows.map((r) => r.field_0));
    });

    it('returns a row wider than 200,000 characters and the row after it', async () => {
      http.route({
        match: /\/resource\/ab12-cd34\.json/,
        respond: sodaEndpoint([{ blob: 'x'.repeat(300_000) }, { blob: 'y' }]),
      });

      const result = await runToolContract(queryDataset, { datasetId: 'ab12-cd34', limit: 2 });
      const sc = structured(result);

      expect(sc.rows).toHaveLength(2);
      expect(tableRows(result)).toHaveLength(2);
      expect(sc.truncated).toBeUndefined();
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

    it('rethrows the caller abort that cuts the probe short instead of answering without it', async () => {
      /**
       * A probe that fails annotates nothing, so the page is answered without it — but a probe
       * the caller cancelled is the caller leaving, and answering anyway would turn the
       * cancellation into a success with a "could not be completed" notice.
       */
      const controller = new AbortController();
      const reason = new Error('caller went away during the probe');
      http.route({
        match: /\/resource\/bi63-dtpu\.json/,
        respond: (request) => {
          if (new URL(request.url).searchParams.get('$offset') !== '0') return Response.json([]);
          // The probe is in flight; it rejects with the reason its signal aborts with, as fetch does.
          const inFlight = new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason));
          });
          controller.abort(reason);
          return inFlight;
        },
      });
      const ctx = createMockContext({ errors: queryDataset.errors, signal: controller.signal });
      const input = queryDataset.input.parse({ datasetId: 'bi63-dtpu', offset: 500 });

      const err = await Promise.resolve(queryDataset.handler(input, ctx)).catch((e: unknown) => e);
      expect(err).toBe(reason);
      expect(http.calls).toHaveLength(2);
    });
  });
});
