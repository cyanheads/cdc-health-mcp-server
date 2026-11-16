/**
 * @fileoverview What a client receives of a failed Socrata response, run through the production
 * error path against the real SocrataService: the upstream body reaches neither surface, a JSON
 * message or page title that says more than the status line joins the message, and a value an
 * error tells the caller to send back renders in `content[]` as a code span it can copy.
 * @module tests/services/socrata/socrata-error-body-wire
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';
import type { ContractError } from '../../helpers/contract-error.js';
import { contentText } from '../../helpers/contract-text.js';
import { readBack, renderMarkdown } from '../../helpers/markdown-render.js';
import { readResourceError } from '../../helpers/resource-read.js';

/** Answers every request afresh, so the metadata read and its parallel row count each get a body. */
function serve(body: string, status: number, statusText: string, contentType: string) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(body, { status, statusText, headers: { 'Content-Type': contentType } }),
  );
}

function errorOf(result: Awaited<ReturnType<typeof runToolContract>>): ContractError {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: ContractError }).error;
}

/** The text of every code span `content[]` renders, read back as a client displays it. */
function codeSpans(text: string): string[] {
  return [...renderMarkdown(text).matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) =>
    readBack(m[1] ?? ''),
  );
}

/** The page openresty serves for a 414, as an edge in front of the data endpoint answers one. */
const OPENRESTY_414 =
  '<html>\r\n<head><title>414 Request-URI Too Large</title></head>\r\n<body>\r\n<center><h1>414 Request-URI Too Large</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n';

describe('Socrata error responses on the wire', () => {
  beforeAll(() => {
    initSocrataService();
  });

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('the upstream body', () => {
    it('keeps an edge proxy page off both surfaces of cdc_query_dataset', async () => {
      serve(OPENRESTY_414, 414, 'URI Too Long', 'text/html');
      const result = await runToolContract(queryDataset, { datasetId: 'bi63-dtpu' });
      const err = errorOf(result);

      expect(err.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(err.data).not.toHaveProperty('body');
      expect(err.data).not.toHaveProperty('responseBody');
      expect(err.message).toBe(
        'Socrata returned HTTP 414 URI Too Long: 414 Request-URI Too Large.',
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain('<');
      expect(contentText(result)).not.toContain('<');
    });

    it('keeps a JSON body off a resource read and relays its message', async () => {
      serve(
        '{"error":true,"code":"dataset.gone","message":"This dataset has been retired"}',
        410,
        'Gone',
        'application/json',
      );
      const err = await readResourceError(datasetDetailResource, 'cdc://datasets/bi63-dtpu');

      expect(err.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(err.data).not.toHaveProperty('body');
      expect(err.data).not.toHaveProperty('responseBody');
      expect(JSON.stringify(err.data)).not.toContain('dataset.gone');
      expect(err.message).toBe('Socrata returned HTTP 410 Gone: This dataset has been retired.');
    });

    it('relays a page title through a tool on both surfaces and keeps upstream_error', async () => {
      serve(
        '<!DOCTYPE html><html><head><title>data.cdc.gov | 522: Connection timed out</title></head><body><h1>Connection timed out</h1></body></html>',
        502,
        'Bad Gateway',
        'text/html',
      );
      const result = await runToolContract(discoverDatasets, { query: 'influenza' });
      const err = errorOf(result);

      expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
      expect(err.message).toBe(
        'Socrata returned HTTP 502 Bad Gateway: data.cdc.gov | 522: Connection timed out.',
      );
      expect(readBack(renderMarkdown(contentText(result)))).toContain(
        'Socrata returned HTTP 502 Bad Gateway: data.cdc.gov | 522: Connection timed out.',
      );
      expect(JSON.stringify(result.structuredContent)).not.toContain('<');
    });
  });

  describe('values the caller sends back', () => {
    it('renders the backtick example of a reserved-word parse error as a code span', async () => {
      serve(
        JSON.stringify({
          code: 'query.compiler.malformed',
          error: true,
          message:
            "Could not parse SoQL query \"select * where group='By Year' limit 101 offset 0\" at line 1 character 16: Expected an expression, but got `GROUP'",
          data: { query: "select * where group='By Year' limit 101 offset 0", position: {} },
        }),
        400,
        'Bad Request',
        'application/json',
      );
      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        where: "group='By Year'",
      });
      const err = errorOf(result);
      const text = contentText(result);

      expect(err.message).toContain("wrap it in backticks — e.g. `group`='By Year'.");
      expect(codeSpans(text)).toContain("`group`='By Year'");
      expect(text).not.toContain('\\`group');
    });

    it('renders the column a group-by error says to add as a code span', async () => {
      serve(
        JSON.stringify({
          errorCode: 'query.soql.column-not-in-group-bys',
          data: { column: 'age__group' },
          message:
            "Query coordinator error: query.soql.column-not-in-group-bys; Column 'age__group' is not in group by",
        }),
        400,
        'Bad Request',
        'application/json',
      );
      const result = await runToolContract(queryDataset, {
        datasetId: 'bi63-dtpu',
        select: 'state, age__group',
        group: 'state',
      });
      const text = contentText(result);

      expect(errorOf(result).message).toContain('Add group="age__group"');
      expect(codeSpans(text)).toContain('age__group');
      expect(text).not.toContain('age\\_\\_group');
    });
  });
});
