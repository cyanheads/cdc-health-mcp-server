/**
 * @fileoverview Runs each of the six Socrata definitions through the production error path
 * against the real SocrataService, so a request that never yields a readable body reaches the
 * caller as the declared retryable `upstream_error` with its recovery hint. The failure classes
 * themselves are tabled at the service seam in `socrata-service-failures.test.ts`; this file
 * proves only the wiring.
 * @module tests/services/socrata/socrata-upstream-error-wiring
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import { datasetsResource } from '@/mcp-server/resources/definitions/datasets.resource.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { listCatalogVocabulary } from '@/mcp-server/tools/definitions/list-catalog-vocabulary.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { initSocrataService } from '@/services/socrata/socrata-service.js';
import { type ContractError, contractError } from '../../helpers/contract-error.js';
import { contentText } from '../../helpers/contract-text.js';
import { readResourceError } from '../../helpers/resource-read.js';

type Failure = { name: string; install: () => void };

/** One failure from each side of the transport: before any response, and a 2xx body that is not JSON. */
const FAILURES: Failure[] = [
  {
    name: 'a network failure',
    install: () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    },
  },
  {
    name: 'an HTML 200',
    install: () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('<html><body>Service maintenance</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      );
    },
  },
];

type Surface = {
  name: string;
  recovery: string | undefined;
  read: () => Promise<ContractError | Awaited<ReturnType<typeof readResourceError>>>;
};

const recoveryOf = (errors: readonly { reason: string; recovery: string }[] | undefined) =>
  errors?.find((e) => e.reason === 'upstream_error')?.recovery;

const SURFACES: Surface[] = [
  {
    name: 'cdc_discover_datasets',
    recovery: recoveryOf(discoverDatasets.errors),
    read: () => contractError(discoverDatasets, { query: 'influenza' }),
  },
  {
    name: 'cdc_get_dataset_schema',
    recovery: recoveryOf(getDatasetSchema.errors),
    read: () => contractError(getDatasetSchema, { datasetId: 'bi63-dtpu' }),
  },
  {
    name: 'cdc_list_catalog_vocabulary',
    recovery: recoveryOf(listCatalogVocabulary.errors),
    read: () => contractError(listCatalogVocabulary, {}),
  },
  {
    name: 'cdc_query_dataset',
    recovery: recoveryOf(queryDataset.errors),
    read: () => contractError(queryDataset, { datasetId: 'bi63-dtpu' }),
  },
  {
    name: 'cdc://datasets',
    recovery: recoveryOf(datasetsResource.errors),
    read: () => readResourceError(datasetsResource, 'cdc://datasets'),
  },
  {
    name: 'cdc://datasets/{datasetId}',
    recovery: recoveryOf(datasetDetailResource.errors),
    read: () => readResourceError(datasetDetailResource, 'cdc://datasets/bi63-dtpu'),
  },
];

const CASES = SURFACES.flatMap((surface) => FAILURES.map((failure) => ({ ...surface, failure })));

describe('Socrata definitions — upstream_error wiring', () => {
  beforeAll(() => {
    initSocrataService();
  });

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(CASES)(
    '$name answers $failure.name as retryable upstream_error with its recovery',
    async ({ failure, read, recovery }) => {
      failure.install();
      const err = await read();

      expect(recovery).toBeDefined();
      expect(err.data).toMatchObject({
        reason: 'upstream_error',
        retryable: true,
        recovery: { hint: recovery },
      });
    },
  );

  it('tells a cdc_query_dataset caller whose request ran out of time how to answer sooner', async () => {
    /**
     * Only the clock the service reads; the tool pipeline's own scheduling stays real. The clock
     * starts a second ahead so the shared service's request spacing, measured from the previous
     * test's request, has already elapsed.
     */
    vi.useFakeTimers({ now: Date.now() + 1_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { promise: sent, resolve: markSent } = Promise.withResolvers<void>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          markSent();
        }),
    );
    const pending = runToolContract(queryDataset, { datasetId: 'bi63-dtpu' });
    // The pipeline reaches the request on its own schedule; the deadline runs from there.
    await sent;
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    const err = (result.structuredContent as { error: ContractError }).error;
    expect(err.data).toMatchObject({ reason: 'upstream_error', retryable: true });
    expect(err.message).toContain('within 20 seconds');
    expect(err.message).toContain('A narrower where or select, or a smaller limit, answers sooner');
    const text = contentText(result);
    expect(text).toContain('A narrower where or select, or a smaller limit, answers sooner');
  });
});
