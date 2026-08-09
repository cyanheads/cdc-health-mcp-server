/**
 * @fileoverview Cross-checks the reasons SocrataService throws against the error contracts
 * of every definition that calls it.
 * @module tests/services/socrata/socrata-contract-parity
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';

/**
 * Reasons `throwBadRequest` raises only for `query.soql.*` upstream codes, which the
 * `/resource/{id}.json` data endpoint is alone in emitting. Every other reason in the
 * service comes out of the shared `fetchJson` status ladder and can reach any caller.
 */
const DATA_ENDPOINT_ONLY = new Set(['no_such_column', 'type_mismatch']);

/** Definitions whose handlers route service failures through `ctx.fail(err.data.reason)`. */
const CONSUMERS = [
  { name: 'cdc_discover_datasets', errors: discoverDatasets.errors },
  { name: 'cdc_get_dataset_schema', errors: getDatasetSchema.errors },
  { name: 'cdc_query_dataset', errors: queryDataset.errors },
  { name: 'cdc://datasets', errors: datasetsResource.errors },
  { name: 'cdc://datasets/{datasetId}', errors: datasetDetailResource.errors },
];

function serviceReasons(): string[] {
  const source = readFileSync(
    new URL('../../../src/services/socrata/socrata-service.ts', import.meta.url),
    'utf8',
  );
  return [...new Set([...source.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]))];
}

describe('SocrataService ↔ definition error contracts', () => {
  it('has every shared reason declared by every consumer', () => {
    /**
     * `ctx.fail` with an undeclared reason does not fall back — it returns an
     * InternalError whose message says the reason is not in `errors[]` and whose data
     * carries the full declared-reason list straight to the caller. So a reason the
     * service can raise on a shared code path has to exist in all five contracts.
     */
    const shared = serviceReasons().filter((r) => !DATA_ENDPOINT_ONLY.has(r));
    expect(shared.length).toBeGreaterThan(0);

    const missing = CONSUMERS.flatMap(({ name, errors }) => {
      const declared = new Set(errors?.map((e) => e.reason));
      return shared.filter((r) => !declared.has(r)).map((r) => `${name} is missing '${r}'`);
    });
    expect(missing).toEqual([]);
  });

  it('declares the two SoQL-only reasons on the data-endpoint tool alone', () => {
    for (const reason of DATA_ENDPOINT_ONLY) {
      expect(queryDataset.errors?.some((e) => e.reason === reason)).toBe(true);
      for (const { errors } of CONSUMERS.filter((c) => c.name !== 'cdc_query_dataset')) {
        expect(errors?.some((e) => e.reason === reason)).toBe(false);
      }
    }
  });

  it('agrees across all five contracts on what each shared reason means', () => {
    /**
     * Parity of names is not enough. Each handler rebuilds the failure from its own
     * contract entry, so one upstream status can arrive as a permanent refusal from one
     * definition and a retryable outage from another once the entries drift. Retryability
     * is the half that misled callers: `upstream_error` is the only non-429 reason allowed
     * to claim a retry, and it is allowed one only because it is now scoped to 5xx.
     */
    const shape: Record<string, { code: JsonRpcErrorCode; retryable?: true; when?: RegExp }> = {
      access_denied: { code: JsonRpcErrorCode.Forbidden, when: /403/ },
      dataset_not_found: { code: JsonRpcErrorCode.NotFound },
      invalid_query: { code: JsonRpcErrorCode.ValidationError },
      rate_limited: { code: JsonRpcErrorCode.RateLimited, retryable: true, when: /429/ },
      upstream_error: { code: JsonRpcErrorCode.ServiceUnavailable, retryable: true, when: /5xx/ },
    };

    for (const { name, errors } of CONSUMERS) {
      for (const entry of errors ?? []) {
        const expected = shape[entry.reason];
        if (!expected) continue;
        expect(entry.code, `${name}.${entry.reason} code`).toBe(expected.code);
        expect(entry.retryable, `${name}.${entry.reason} retryable`).toBe(expected.retryable);
        // Only the status-banded reasons need their band named; the rest phrase `when`
        // around the caller-visible cause, which differs legitimately per definition.
        if (expected.when) {
          expect(entry.when, `${name}.${entry.reason} when`).toMatch(expected.when);
        }
        if (!expected.retryable) {
          expect(entry.recovery, `${name}.${entry.reason} recovery`).not.toMatch(
            /temporarily unavailable|retry after a brief delay/i,
          );
        }
      }
    }
  });

  it('throws every reason it declares — no contract entry without a raise site', () => {
    /**
     * The reverse direction: a declared reason nothing can produce is dead advertising.
     * The two reasons raised in handlers rather than the service are listed explicitly.
     */
    const handlerRaised = new Set(['not_queryable', 'page_out_of_range']);
    const raisable = new Set([...serviceReasons(), ...handlerRaised]);

    for (const { name, errors } of CONSUMERS) {
      for (const entry of errors ?? []) {
        expect(raisable, `${name} declares unraisable '${entry.reason}'`).toContain(entry.reason);
      }
    }
  });
});
