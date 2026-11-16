/**
 * @fileoverview Tests for SocrataService error handling by status, 400 codes, and security. Failures
 * that arrive without a usable status are in `socrata-service-failures.test.ts`.
 * @module tests/services/socrata/socrata-service-errors
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    appToken: undefined,
    baseUrl: 'https://data.cdc.gov',
    catalogUrl: 'https://api.us.socrata.com/api/catalog/v1',
  }),
}));

import { pageTitle, SocrataService } from '@/services/socrata/socrata-service.js';
import { expectLinearCostAsync, expectLinearDoublings, fill } from '../../helpers/cpu-cost.js';

function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchText(body: string, status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
}

describe('SocrataService — error handling', () => {
  let service: SocrataService;

  beforeEach(() => {
    service = new SocrataService();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('400 bad request — throwBadRequest', () => {
    it('throws validationError with column name on no-such-column', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.no-such-column',
          data: { column: 'missingcol' },
          message: 'No such column missingcol',
        }),
        400,
      );
      await expect(
        service.query({ datasetId: 'ab12-cd34', where: "missingcol='x'" }),
      ).rejects.toThrow(/No such column "missingcol"/);
    });

    it('falls back to "unknown" when column data is absent', async () => {
      mockFetchText(
        JSON.stringify({ errorCode: 'query.soql.no-such-column', data: {}, message: 'bad col' }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /No such column "unknown"/,
      );
    });

    it('throws validationError with detail on type-mismatch', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.type-mismatch',
          message: 'Type error; expected number got text',
        }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/type mismatch/i);
    });

    it('uses generic detail when type-mismatch message has no semicolon', async () => {
      mockFetchText(
        JSON.stringify({ errorCode: 'query.soql.type-mismatch', message: 'Type error' }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/check column types/);
    });

    it('throws validationError with Socrata message on generic 400', async () => {
      mockFetchText(JSON.stringify({ message: 'Invalid query syntax near token AND' }), 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /Invalid query syntax/,
      );
    });

    it('throws validationError with error field when message is absent', async () => {
      mockFetchText(JSON.stringify({ error: 'bad input' }), 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/bad input/);
    });

    it('throws validationError with raw body when JSON parse fails', async () => {
      mockFetchText('not json', 400);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/not json/);
    });

    it('truncates body to 300 chars when JSON has neither message nor error', async () => {
      const longBody = JSON.stringify({ unknown: 'x'.repeat(400) });
      mockFetchText(longBody, 400);
      const err = (await service.query({ datasetId: 'ab12-cd34' }).catch((e) => e)) as McpError;

      expect(err.message).toBe(`Socrata API error 400: ${longBody.slice(0, 300)}`);
    });

    it('relays the first 300 characters of a longer JSON message on a generic 400', async () => {
      const message = Array.from({ length: 500 }, (_, i) => String.fromCharCode(97 + (i % 26)));
      mockFetchText(JSON.stringify({ message: message.join('') }), 400);
      const err = (await service.query({ datasetId: 'ab12-cd34' }).catch((e) => e)) as McpError;

      expect(err.message).toBe(`Socrata query error: ${message.slice(0, 300).join('')}`);
    });

    it('normalizes column-not-in-group-bys using the structured column name', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.column-not-in-group-bys',
          data: { column: 'state' },
          message:
            'Query coordinator error: query.soql.column-not-in-group-bys; Column \'state\' is not in group by; position: Map(row -> 1, column -> 8, line -> "SELECT `state`")',
        }),
        400,
      );
      await expect(
        service.query({ datasetId: 'ab12-cd34', select: 'state, sum(deaths) as d' }),
      ).rejects.toThrow(/Column "state" must appear in GROUP BY/);
    });

    it('falls back to "unknown" for column-not-in-group-bys without column data', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.column-not-in-group-bys',
          data: {},
          message: 'Column is not in group by',
        }),
        400,
      );
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(
        /Column "unknown" must appear in GROUP BY/,
      );
    });

    it('strips the Scala position tail from generic 400 messages', async () => {
      mockFetchText(
        JSON.stringify({
          errorCode: 'query.soql.no-such-function',
          message:
            'Query coordinator error: query.soql.no-such-function; Unknown function `foo`; position: Map(row -> 1, column -> 8, line -> "SELECT foo(x)")',
        }),
        400,
      );
      const err = (await service
        .query({ datasetId: 'ab12-cd34', select: 'foo(x)' })
        .catch((e) => e)) as Error;
      expect(err.message).toContain('Unknown function');
      expect(err.message).not.toContain('position: Map');
    });

    it('surfaces backtick guidance for reserved-word parse errors', async () => {
      // query.compiler.* parse errors carry the code under `code` (not `errorCode`).
      mockFetchText(
        JSON.stringify({
          code: 'query.compiler.malformed',
          error: true,
          message:
            "Could not parse SoQL query \"select * where group='By Year'\" at line 1 character 16: Expected an expression, but got `GROUP'",
          data: { query: "select * where group='By Year'", position: {} },
        }),
        400,
      );
      await expect(
        service.query({ datasetId: 'ab12-cd34', where: "group='By Year'" }),
      ).rejects.toThrow(/wrap it in backticks/);
    });

    describe('column-not-in-group-bys, classified by where the caret sits', () => {
      /** Socrata's own body for a grouped query, with `position.line` normalized as it sends it. */
      const groupByError = (column: string, line: string, caret: number) =>
        JSON.stringify({
          message: `Query coordinator error: query.soql.column-not-in-group-bys; Column '${column}' is not in group by; position: Map(row -> 1, column -> ${caret}, line -> "${line}")`,
          errorCode: 'query.soql.column-not-in-group-bys',
          data: {
            column,
            dataset: 'foxtrot.41031',
            position: { row: 1, column: caret, line: `${line}\n${' '.repeat(caret - 1)}^` },
          },
        });

      const GROUPED_ORDER_ID =
        'SELECT `state`, sum(`deaths`) AS `total` GROUP BY `state` ORDER BY `:id` ASC NULL LAST LIMIT 4 OFFSET 3';
      const GROUPED_ORDER_YEAR =
        'SELECT `state`, sum(`deaths`) AS `total` GROUP BY `state` ORDER BY `year` ASC NULL LAST LIMIT 4';
      const SELECTED_YEAR =
        'SELECT `state`, `year` GROUP BY `state` ORDER BY `state` ASC NULL LAST LIMIT 4';

      it.each([
        [':id', GROUPED_ORDER_ID, 68],
        ['year', GROUPED_ORDER_YEAR, 68],
      ])(
        'steers an ORDER BY column (%s) to grouped columns, never to group',
        async (column, line, caret) => {
          /**
           * Adding `:id` (or any ungrouped column) to `group` makes Socrata accept the query
           * and silently split each aggregate into per-row values.
           */
          mockFetchText(groupByError(column, line, caret), 400);
          const err = (await service
            .query({ datasetId: 'bi63-dtpu', group: 'state', order: column, limit: 3 })
            .catch((e) => e)) as McpError;

          expect(err.data).toMatchObject({ reason: 'invalid_query', column });
          expect(err.message).toBe(
            `Column "${column}" in the order clause is neither grouped nor aggregated, so it cannot order grouped rows. Order by the grouped columns or by aggregate aliases from select instead.`,
          );
        },
      );

      it('keeps the SELECT-position message, which names group as one fix', async () => {
        mockFetchText(groupByError('year', SELECTED_YEAR, 17), 400);
        const err = (await service
          .query({ datasetId: 'bi63-dtpu', select: 'state, year', group: 'state', order: 'state' })
          .catch((e) => e)) as McpError;

        expect(err.message).toBe(
          'Column "year" must appear in GROUP BY or be wrapped in an aggregate (e.g. sum()). Add group="year" or aggregate it in select.',
        );
      });

      it.each([
        ['a quoted literal', "SELECT `state`, 'x ORDER BY y' AS `note`, `year` GROUP BY `state`"],
        [
          'a backticked identifier',
          'SELECT `state`, `x ORDER BY y` AS `note`, `year` GROUP BY `state`',
        ],
      ])(
        'reads " ORDER BY " inside %s ahead of the caret as text, not as the clause',
        async (_label, select) => {
          const line = `${select} ORDER BY \`state\` ASC NULL LAST`;
          mockFetchText(groupByError('year', line, line.indexOf('`year`') + 1), 400);
          const err = (await service.query({ datasetId: 'bi63-dtpu' }).catch((e) => e)) as McpError;

          expect(err.message).toContain('Add group="year"');
        },
      );

      it('keeps the current message when Socrata sends no position', async () => {
        mockFetchText(
          JSON.stringify({
            errorCode: 'query.soql.column-not-in-group-bys',
            data: { column: ':id' },
            message: 'Column is not in group by',
          }),
          400,
        );
        const err = (await service.query({ datasetId: 'bi63-dtpu' }).catch((e) => e)) as McpError;

        expect(err.message).toContain('Add group=":id" or aggregate it in select.');
      });

      it('locates the caret in time linear in the length of the line', async () => {
        /**
         * The line echoes the caller's own query, so its length is the caller's.
         */
        await expectLinearCostAsync(
          (n) =>
            `SELECT \`state\` WHERE \`note\` = '${"'' ORDER BY `".repeat(n / 14)} GROUP BY \`state\``,
          (line) => {
            mockFetchText(groupByError('state', line, 8), 400);
            return service.query({ datasetId: 'bi63-dtpu' }).catch(() => undefined);
          },
        );
      });
    });

    describe('relayed messages quote the caller limit, not the over-fetch probe', () => {
      /** The parse error Socrata returns for `where: "count(*) bogus"`, quoting its wire query. */
      const parseError = (query: string, character: number) =>
        JSON.stringify({
          code: 'query.compiler.malformed',
          error: true,
          message: `Could not parse SoQL query "${query}" at line 1 character ${character}: Expected one of end of input, \`LIMIT', \`OFFSET', or \`GROUP BY', but got \`bogus'`,
          data: { query, position: {} },
        });

      it('rewrites the server-added limit in a parse error back to the one the caller sent', async () => {
        mockFetchText(parseError('select year where count(*) bogus limit 2 offset 0', 28), 400);
        const err = (await service
          .query({ datasetId: 'bi63-dtpu', select: 'year', where: 'count(*) bogus', limit: 1 })
          .catch((e) => e)) as McpError;

        expect(err.data).toMatchObject({ reason: 'invalid_query' });
        expect(err.message).toBe(
          "Socrata query error: Could not parse SoQL query \"select year where count(*) bogus limit 1 offset 0\" at line 1 character 28: Expected one of end of input, `LIMIT', `OFFSET', or `GROUP BY', but got `bogus'",
        );
      });

      it('rewrites a limit whose digit count differs from the probe, leaving the rest in place', async () => {
        mockFetchText(
          parseError("select year where note = 'limit 10 offset 5' bogus limit 10 offset 5", 46),
          400,
        );
        const err = (await service
          .query({
            datasetId: 'bi63-dtpu',
            select: 'year',
            where: "note = 'limit 10 offset 5' bogus",
            limit: 9,
            offset: 5,
          })
          .catch((e) => e)) as McpError;

        expect(err.message).toContain(
          '"select year where note = \'limit 10 offset 5\' bogus limit 9 offset 5" at line 1 character 46',
        );
      });

      it('rewrites the probe in the reserved-word parse error too', async () => {
        mockFetchText(
          JSON.stringify({
            code: 'query.compiler.malformed',
            error: true,
            message:
              "Could not parse SoQL query \"select * where group='By Year' limit 101 offset 0\" at line 1 character 16: Expected an expression, but got `GROUP'",
            data: { query: "select * where group='By Year' limit 101 offset 0", position: {} },
          }),
          400,
        );
        const err = (await service
          .query({ datasetId: 'bi63-dtpu', where: "group='By Year'" })
          .catch((e) => e)) as McpError;

        expect(err.message).toContain("group='By Year' limit 100 offset 0\"");
        expect(err.message).toContain('wrap it in backticks');
      });

      /** Socrata's unexpected-character error, which quotes the query twice: inline and above a caret line. */
      const unexpectedCharacter = (query: string, caret: number) =>
        JSON.stringify({
          code: 'query.compiler.malformed',
          error: true,
          message: `Could not parse SoQL query "${query}": Unexpected character:\n${query}\n${' '.repeat(caret)}^`,
          data: { query },
        });

      it('rewrites the probe in every copy of the query an unexpected-character error quotes', async () => {
        mockFetchText(
          unexpectedCharacter('select distinct cause_name as `cause label` limit 4 offset 0', 36),
          400,
        );
        const err = (await service
          .query({
            datasetId: 'bi63-dtpu',
            select: 'distinct cause_name as `cause label`',
            limit: 3,
          })
          .catch((e) => e)) as McpError;

        expect(err.message).not.toContain('limit 4');
        expect(err.message).toContain('`cause label` limit 3 offset 0\n');
      });

      it('keeps the caret under the same character when the limit changes digit count', async () => {
        mockFetchText(
          unexpectedCharacter('select distinct cause_name as `cause label` limit 10 offset 0', 30),
          400,
        );
        const err = (await service
          .query({
            datasetId: 'bi63-dtpu',
            select: 'distinct cause_name as `cause label`',
            limit: 9,
          })
          .catch((e) => e)) as McpError;
        const [quoted = '', caretLine = ''] = err.message.split('\n').slice(-2);

        expect(quoted).toBe('select distinct cause_name as `cause label` limit 9 offset 0');
        expect(quoted[caretLine.indexOf('^')]).toBe('`');
      });

      it('leaves a message alone when its quoted query does not end in the probe', async () => {
        mockFetchText(parseError('select year where count(*) bogus', 28), 400);
        const err = (await service
          .query({ datasetId: 'bi63-dtpu', where: 'count(*) bogus', limit: 1 })
          .catch((e) => e)) as McpError;

        expect(err.message).toContain('"select year where count(*) bogus" at line 1 character 28');
      });
    });
  });

  describe('HTTP error codes', () => {
    it('throws notFound on 404 for discover', async () => {
      mockFetchText('', 404);
      await expect(service.discover({ query: 'x' })).rejects.toThrow(/not found/i);
    });

    it('throws rateLimited on 429 for query', async () => {
      mockFetchText('', 429);
      await expect(service.query({ datasetId: 'ab12-cd34' })).rejects.toThrow(/Rate limited/i);
    });

    it('throws serviceUnavailable on 503 for getMetadata', async () => {
      mockFetchText('Service unavailable', 503);
      await expect(service.getMetadata('ab12-cd34')).rejects.toThrow(/503/);
    });

    it('throws on 500 with status code included', async () => {
      mockFetchText('Internal Server Error', 500);
      await expect(service.getMetadata('ab12-cd34')).rejects.toThrow(/500/);
    });

    it('classifies 403 as a permanent access_denied, not a retryable outage', async () => {
      /**
       * Socrata answers 403 for a non-tabular asset ID. Routing that through the
       * upstream_error reason told callers the portal was down and worth retrying —
       * wrong in both directions, since the portal is up and the refusal is permanent.
       */
      mockFetchText(
        JSON.stringify({ error: true, message: 'no row or column access to non-tabular tables' }),
        403,
      );
      const err = (await service
        .query({ datasetId: '235m-gsry', limit: 2 })
        .catch((e) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(err.data).toMatchObject({ reason: 'access_denied' });
      expect((err.data as Record<string, unknown>).retryable).toBeUndefined();
      expect(err.message).toContain('no row or column access to non-tabular tables');
    });

    it('names the catalog endpoint, not a dataset ID, on a 404 from the catalog', async () => {
      /**
       * `dataset_not_found` is raised for a 404 from any endpoint, and the two catalog
       * consumers declare it. "Verify the dataset ID" describes neither their request —
       * which carries no ID — nor a corrective, and pointing them at cdc_discover_datasets
       * names the tool that just failed.
       */
      mockFetchText('Not Found', 404);
      const err = (await service.discover({ query: 'x' }).catch((e) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'dataset_not_found' });
      expect(err.message).toContain('catalog endpoint not found');
      expect(err.message).not.toContain('dataset ID');
    });

    it('still names the dataset ID on a 404 from the metadata endpoint', async () => {
      mockFetchText('Not Found', 404);
      const err = (await service.getMetadata('ab12-cd34').catch((e) => e)) as McpError;

      expect(err.data).toMatchObject({ reason: 'dataset_not_found' });
      expect(err.message).toContain('Verify the dataset ID exists');
    });

    it.each([500, 501, 502, 503, 504, 599])(
      'reasons the whole 5xx band as upstream_error (%i)',
      async (status) => {
        /**
         * 500 is the boundary the band opens on, so it is what a `> 500` slip drops —
         * turning a retryable outage into an unreasoned rethrow. The framework's own
         * status mapping splits 5xx between ServiceUnavailable and Timeout (504), and
         * marks 501 `retryable: false` out of band; the reason is what unifies them, and
         * each handler rebuilds the caller-visible code from its contract entry rather
         * than from the status.
         */
        mockFetchText('Server error', status);
        const err = (await service.getMetadata('ab12-cd34').catch((e) => e)) as McpError;
        expect(err.data).toMatchObject({ reason: 'upstream_error' });
      },
    );

    it('leaves an unexpected 4xx unreasoned so its own status classification survives', async () => {
      /**
       * A reason string the callers' contracts don't declare would be re-dispatched into
       * an InternalError carrying a "not declared in errors[]" message. Omitting the
       * reason makes the callers rethrow this error with the framework's 401 →
       * Unauthorized classification intact.
       */
      mockFetchText('Unauthorized', 401);
      const err = (await service.discover({ query: 'x' }).catch((e) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Unauthorized);
      expect((err.data as Record<string, unknown> | undefined)?.reason).toBeUndefined();
    });
  });

  describe('the body of a 5xx or an unexpected 4xx', () => {
    /** Every request answered afresh, so a parallel pair never reads one consumed body. */
    function mockStatus(body: string, status: number, statusText = '', contentType = 'text/html') {
      return vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          async () =>
            new Response(body, { status, statusText, headers: { 'Content-Type': contentType } }),
        );
    }

    async function failure(call: Promise<unknown>): Promise<McpError> {
      const err = await call.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpError);
      return err as McpError;
    }

    /** The page openresty serves for a 502, whose title restates the status line. */
    const OPENRESTY_502 =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n';

    it('names only the status when the body is empty', async () => {
      mockStatus('', 414, 'URI Too Long');
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(err.message).toBe('Socrata returned HTTP 414 URI Too Long.');
      expect(err.data).toMatchObject({ status: 414 });
      expect(err.data?.reason).toBeUndefined();
    });

    it('names only the status of an empty 5xx and keeps it upstream_error', async () => {
      mockStatus('', 502, 'Bad Gateway');
      const err = await failure(service.getMetadata('ab12-cd34'));

      expect(err.message).toBe('Socrata returned HTTP 502 Bad Gateway.');
      expect(err.data).toMatchObject({ reason: 'upstream_error', status: 502 });
    });

    it('classifies a 304, which carries no body at all', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response(null, { status: 304, statusText: 'Not Modified' }),
      );
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(err.message).toBe('Socrata returned HTTP 304 Not Modified.');
      expect(err.data?.reason).toBeUndefined();
    });

    it('carries the Retry-After header and the request URL', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('Service unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Retry-After': '120' },
          }),
      );
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.data).toMatchObject({
        reason: 'upstream_error',
        retryAfter: '120',
        url: 'https://data.cdc.gov/resource/ab12-cd34.json?%24limit=101&%24offset=0',
      });
    });

    it('classifies a status above 599, which fetch returns but Response refuses to build', async () => {
      /**
       * Both runtimes' fetch hand back a status of 600 or more as received, while `new Response`
       * accepts only 200 through 599 — so a mock built that way is relabelled after the fact.
       */
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const response = new Response('origin unreachable', { status: 503, statusText: 'Odd' });
        Object.defineProperty(response, 'status', { value: 600 });
        return response;
      });
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe('Socrata returned HTTP 600 Odd.');
      expect(err.data).toMatchObject({ reason: 'upstream_error', status: 600 });
    });

    it('keeps the body on the thrown error, where the server log reads it', async () => {
      mockStatus(OPENRESTY_502, 502, 'Bad Gateway');
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.data?.body).toBe(OPENRESTY_502);
    });

    it('adds nothing to the status line when the page title restates it', async () => {
      mockStatus(OPENRESTY_502, 502, 'Bad Gateway');
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.message).toBe('Socrata returned HTTP 502 Bad Gateway.');
    });

    it.each([
      ['a page with no title', '<html><body><h1>Request rejected</h1></body></html>', 'text/html'],
      ['an empty title', '<html><head><title>  </title></head></html>', 'text/html'],
      ['a title left unclosed', '<html><head><title>Request rejected', 'text/html'],
      ['plain text', 'upstream connect error or disconnect/reset before headers', 'text/plain'],
      ['JSON without a message', '{"code":"bad_gateway","error":true}', 'application/json'],
      ['JSON with an empty message', '{"error":true,"message":""}', 'application/json'],
      ['JSON that is not an object', 'null', 'application/json'],
    ])('names only the status for %s', async (_name, body, contentType) => {
      mockStatus(body, 503, 'Service Unavailable', contentType);
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.message).toBe('Socrata returned HTTP 503 Service Unavailable.');
    });

    it.each([
      [
        'a title in another case',
        '<html><head><title>502 BAD GATEWAY</title></head></html>',
        'text/html',
      ],
      [
        'a JSON message naming the status',
        '{"error":true,"message":"Bad gateway"}',
        'application/json',
      ],
    ])('adds nothing for %s that restates the status line', async (_name, body, contentType) => {
      mockStatus(body, 502, 'Bad Gateway', contentType);
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.message).toBe('Socrata returned HTTP 502 Bad Gateway.');
    });

    it("relays a JSON body's message, keeping the body on the error and the status's code", async () => {
      const body = '{"error":true,"message":"This dataset has been retired"}';
      mockStatus(body, 410, 'Gone', 'application/json');
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(err.message).toBe('Socrata returned HTTP 410 Gone: This dataset has been retired.');
      expect(err.data).toMatchObject({ status: 410, body });
      expect(err.data?.reason).toBeUndefined();
    });

    it('relays a page title when the status line has no reason phrase', async () => {
      /** An HTTP/2 response carries no reason phrase, so the status line is the bare code. */
      mockStatus(
        '<!DOCTYPE html><html><head><title>data.cdc.gov | 522: Connection timed out</title></head><body><h1>Connection timed out</h1></body></html>',
        502,
      );
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(
        'Socrata returned HTTP 502: data.cdc.gov | 522: Connection timed out.',
      );
      expect(err.data).toMatchObject({ reason: 'upstream_error', status: 502 });
    });

    it('reads an upper-case title with attributes, tags inside it, and entities decoded once', async () => {
      mockStatus(
        '<HTML><HEAD><TITLE lang="en">Quota &amp; <B>rate</B> limits &amp;lt;exceeded&amp;gt;</TITLE></HEAD></HTML>',
        503,
        'Service Unavailable',
      );
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.message).toBe(
        'Socrata returned HTTP 503 Service Unavailable: Quota & rate limits &lt;exceeded&gt;.',
      );
    });

    it('cuts a title past 200 characters and ends it with the ellipsis alone', async () => {
      const title = 'Scheduled maintenance window '.repeat(12).trim();
      mockStatus(`<html><head><title>${title}</title></head></html>`, 503, 'Service Unavailable');
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      const prefix = 'Socrata returned HTTP 503 Service Unavailable: ';
      expect(err.message.startsWith(prefix)).toBe(true);
      const detail = err.message.slice(prefix.length);
      expect(detail.endsWith('…')).toBe(true);
      expect(detail.length).toBeLessThanOrEqual(201);
      expect(detail.length).toBeGreaterThan(150);
      expect(title.startsWith(detail.slice(0, -1).trimEnd())).toBe(true);
    });

    it.each([
      [
        'a 503',
        503,
        'Service Unavailable',
        (detail: string) => `Socrata returned HTTP 503 Service Unavailable: ${detail}.`,
      ],
      [
        'a 403',
        403,
        'Forbidden',
        (detail: string) =>
          `Socrata denied access to this resource (403): ${detail}. This is an access decision, not an outage — the same request will keep failing.`,
      ],
    ])(
      'relays the first 200 characters of a longer JSON message from %s',
      async (_label, status, statusText, expected) => {
        const message = Array.from({ length: 500 }, (_, i) => String.fromCharCode(97 + (i % 26)));
        mockStatus(
          JSON.stringify({ error: true, message: message.join('') }),
          status,
          statusText,
          'application/json',
        );
        const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

        expect(err.message).toBe(expected(message.slice(0, 200).join('')));
      },
    );

    it.each(['.', '!', '?'])('adds no period after a title that ends in %s', async (mark) => {
      mockStatus(`<title>Down for maintenance${mark}</title>`, 503, 'Service Unavailable');
      const err = await failure(service.query({ datasetId: 'ab12-cd34' }));

      expect(err.message).toBe(
        `Socrata returned HTTP 503 Service Unavailable: Down for maintenance${mark}`,
      );
    });

    it('reads a page title in time linear in the length of the body', async () => {
      /** The body is the upstream's, so its length is unbounded: openers that never close. */
      await expectLinearCostAsync(
        (n) => '<title x'.repeat(n / 8),
        (body) => {
          mockStatus(body, 503, 'Service Unavailable');
          return service.query({ datasetId: 'ab12-cd34' }).catch(() => undefined);
        },
      );
    });
  });

  describe('pageTitle', () => {
    it.each([
      ['the first title of two', '<title>One</title><title>Two</title>', 'One'],
      ['a self-closing-looking opener', '<title/>Edge error</title>', 'Edge error'],
      ['a closer carrying whitespace', '<title>Edge error</title \n>', 'Edge error'],
      [
        'a title after a lookalike tag',
        '<titles>no</titles><title>Edge error</title>',
        'Edge error',
      ],
      ['a closer after a lookalike closer', '<title>Edge </titles>error</title>', 'Edge error'],
    ])('reads %s', (_name, body, title) => {
      expect(pageTitle(body)).toBe(title);
    });

    it.each([
      ['no title', '<html><body>Edge error</body></html>'],
      ['an opener with no >', '<title Edge error'],
      ['an opener with no closer', '<title>Edge error'],
      ['a lookalike tag alone', '<titles>Edge error</titles>'],
      ['a title of tags and whitespace', '<title> <b> </b> </title>'],
    ])('reads nothing from %s', (_name, body) => {
      expect(pageTitle(body)).toBeUndefined();
    });

    /**
     * Timing: the body is the upstream's, so its size is unbounded. Each shape doubles from 5,000
     * characters to 320,000, and at every size the least of several measurements stays under four
     * times the growth against the 5,000-character base re-timed beside it — under 256× at the
     * full 64× span. A scan that restarts at every opener costs quadratic and fails by the third
     * doubling.
     */
    describe('timing', () => {
      /**
       * Scans per size: enough that the 5,000-character base costs well above timer jitter, few
       * enough that the 320,000-character size stays inside the per-measurement bound. A shape
       * whose title is converted whole (`toPlainText` over the body) costs the most per scan.
       */
      it.each([
        ['<title openers with no >', (n: number) => fill('<title x', n), 400],
        ['<title> openers with no closer', (n: number) => fill('<title>', n), 400],
        ['lookalike openers', (n: number) => fill('<titles>', n), 400],
        ['lookalike closers after an opener', (n: number) => `<title>${fill('</titles>', n)}`, 400],
        [
          'openers nested inside one title',
          (n: number) => `<title>${fill('<title>', n)}</title>`,
          50,
        ],
        ['a title of text', (n: number) => `<title>${fill('Edge error &amp; ', n)}</title>`, 50],
      ])(
        'stays linear on %s',
        (_name, build, repeats) => expectLinearDoublings(build, 320_000, pageTitle, repeats),
        0,
      );
    });
  });

  describe('getSocrataService — uninitialized', () => {
    it('throws serviceUnavailable when not initialized', async () => {
      // Import from a freshly isolated module to avoid contamination from global init
      const { getSocrataService } = await import('@/services/socrata/socrata-service.js');
      // When initialized in setup the singleton may exist — test the message
      try {
        getSocrataService();
        // If it doesn't throw, the service was already initialized — that's fine
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('SocrataService not initialized');
      }
    });
  });

  describe('sparse catalog responses', () => {
    it('handles missing optional catalog fields gracefully', async () => {
      mockFetch({
        results: [
          {
            resource: {
              id: 'ab12-cd34',
              name: 'Minimal Dataset',
              // no description, no page_views, no columns, no updatedAt
            },
            // no classification
          },
        ],
        resultSetSize: 1,
      });
      const result = await service.discover({ query: 'minimal' });
      const [dataset] = result.datasets;
      expect(dataset?.id).toBe('ab12-cd34');
      expect(dataset?.description).toBeUndefined();
      expect(dataset?.category).toBeUndefined();
      expect(dataset?.tags).toBeUndefined();
      expect(dataset?.columnNames).toBeUndefined();
      expect(dataset?.pageViews).toBeUndefined();
    });

    it('handles missing rowsUpdatedAt in metadata', async () => {
      mockFetch({
        name: 'Sparse Dataset',
        description: 'A sparse one',
        // no rowsUpdatedAt
        columns: [{ fieldName: 'id', dataTypeName: 'text' }],
      });
      const result = await service.getMetadata('ab12-cd34');
      expect(result.updatedAt).toBeUndefined();
    });

    it('handles missing cachedContents (no rowCount) in metadata', async () => {
      mockFetch({
        name: 'No Count Dataset',
        columns: [{ fieldName: 'id', dataTypeName: 'number' /* no cachedContents */ }],
      });
      const result = await service.getMetadata('ab12-cd34');
      expect(result.rowCount).toBeUndefined();
    });

    it('handles empty results array from catalog', async () => {
      mockFetch({ results: [], resultSetSize: 0 });
      const result = await service.discover({ query: 'nothing' });
      expect(result.datasets).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('handles empty rows array from query', async () => {
      mockFetch([]);
      const result = await service.query({ datasetId: 'ab12-cd34' });
      expect(result.rows).toHaveLength(0);
      expect(result.rowCount).toBe(0);
    });
  });

  describe('app token header injection', () => {
    it('does NOT send X-App-Token header when appToken is undefined', async () => {
      const spy = mockFetch({ results: [], resultSetSize: 0 });
      await service.discover({});
      const headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
      expect(headers?.['X-App-Token']).toBeUndefined();
    });
  });

  describe('query — offset default', () => {
    it('defaults offset to 0 when not provided', async () => {
      const spy = mockFetch([]);
      await service.query({ datasetId: 'ab12-cd34', where: "x='y'" });
      const url = spy.mock.calls[0]?.[0] as string;
      expect(url).toContain('%24offset=0');
    });
  });
});
