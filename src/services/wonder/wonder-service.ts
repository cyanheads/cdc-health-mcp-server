/**
 * @fileoverview CDC WONDER mortality API client. Builds an XML request for the selected
 * mortality database, POSTs it form-urlencoded to that database's WONDER controller endpoint,
 * and parses the `<data-table>` response into keyed rows.
 *
 * Two live-API constraints are handled here:
 *  - WONDER sits behind an Akamai bot filter that blocks browser-*claiming* clients (a browser
 *    UA + Origin/Referer with a non-browser TLS fingerprint → 403). Requests are sent with only
 *    a Content-Type header — an honest programmatic client passes.
 *  - The API enforces a hard gap between requests (429 otherwise), so calls are spaced. The gap
 *    runs from the end of the previous response, not from when its request was issued — a
 *    request sent 15 s after the previous one *started* is still rejected. It is also per source
 *    IP and shared across databases, so the gate is one instance-level stamp covering every
 *    database rather than a per-database limiter. Overlapping calls queue in one instance-level
 *    lane and go out one at a time, each spaced from the response before it.
 * @module services/wonder/wonder-service
 */

import { rateLimited, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  type WonderDatabaseSpec,
  type WonderQueryOptions,
  type WonderResult,
  wonderDatabaseSpec,
} from './types.js';
import { type BuiltRequest, buildRequestXml } from './xml-builder.js';
import { parseDataTable, parseMessages } from './xml-parser.js';

/** WONDER is always this host — not configurable (unlike Socrata's multi-portal reality). */
const WONDER_BASE_URL = 'https://wonder.cdc.gov';

/**
 * Gap enforced between the end of one response and the start of the next request. WONDER
 * documents 15 s and returns 429 below it, with no `Retry-After` and no rate-limit headers to
 * negotiate against; the extra second is margin for clock skew and upstream jitter rather than
 * a second limit. A 429 does not lengthen the window, so there is no backoff state to carry.
 */
const MIN_REQUEST_INTERVAL_MS = 16_000;

/** Resolve when `turn` does, or reject at once with the abort reason if `signal` fires first. */
function awaitTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return turn;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export class WonderService {
  private lastRequestTime = 0;
  /**
   * Tail of the request lane: settles once every call queued so far has settled. Never
   * rejects — each link resolves on its call's settlement, success or not — so a failed or
   * aborted call can never wedge the calls queued behind it.
   */
  private lane: Promise<void> = Promise.resolve();

  /**
   * Run a mortality query against the selected database. Builds the request XML, waits its
   * turn in the request lane, spaces the request to respect the WONDER rate limit, POSTs it,
   * and parses the response into keyed rows.
   *
   * Calls go through one process-wide lane, one at a time. Reading the shared stamp on entry is
   * not enough on its own: calls that arrive together all read the same stamp, wait the same
   * time, and go out in the same instant, and all but one draw a 429. So each call waits for
   * the one ahead of it to settle before it measures the gap. The lane and the spacing are
   * instance-level and cover every database — WONDER's limit is per source IP, not per
   * dataset, so a D77 request 14 s after a D176 response is still rejected.
   *
   * A call aborted while it waits rejects at once and sends nothing. Its place in the lane
   * still resolves only after the call ahead of it settles, so the call behind it keeps
   * waiting for the request actually in flight.
   */
  async query(options: WonderQueryOptions, signal?: AbortSignal): Promise<WonderResult> {
    const spec = wonderDatabaseSpec(options.database);
    const request = buildRequestXml(options);

    const turn = this.lane;
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    this.lane = turn.then(() => settled);

    try {
      await awaitTurn(turn, signal);
      await this.throttle(signal);
      return await this.send(spec, request, signal);
    } finally {
      settle();
    }
  }

  /** POST one request and parse its response. Stamps the gap however the request ends. */
  private async send(
    spec: WonderDatabaseSpec,
    { xml, columns, dimensionCount }: BuiltRequest,
    signal?: AbortSignal,
  ): Promise<WonderResult> {
    try {
      const response = await globalThis
        .fetch(`${WONDER_BASE_URL}/controller/datarequest/${spec.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ request_xml: xml, accept_datause_restrictions: 'true' }),
          signal: signal ?? null,
        })
        .catch((err: unknown) => {
          throw serviceUnavailable(
            'Failed to reach the CDC WONDER API. Retry after a brief delay.',
            { reason: 'upstream_error', cause: (err as Error).message },
          );
        });

      const body = await response.text().catch(() => '');

      if (response.status === 429) {
        throw rateLimited(
          'CDC WONDER rate limit hit — the API requires at least 15 seconds between consecutive requests, counted from the end of the previous response. Retry after a short pause.',
          { reason: 'rate_limited' },
        );
      }

      const messages = parseMessages(body);

      if (!response.ok || body.includes('Access Denied')) {
        // WONDER reports malformed-request problems in <message> with a 400/500; surface it as a
        // validation error so the agent can correct the query. A bodyless failure is infrastructure.
        const message = messages[0];
        if (message) {
          throw validationError(`CDC WONDER rejected the request: ${message}`, {
            reason: 'invalid_query',
            status: response.status,
          });
        }
        throw serviceUnavailable(
          `CDC WONDER returned an unexpected response (HTTP ${response.status}). Retry after a brief delay.`,
          { reason: 'upstream_error', status: response.status },
        );
      }

      if (!body.includes('<data-table')) {
        const message = messages[0];
        throw serviceUnavailable(
          `CDC WONDER returned no data table${message ? `: ${message}` : ''}. Retry after a brief delay.`,
          { reason: 'upstream_error' },
        );
      }

      const { rows, caveats, cellNotes, suppressedCount } = parseDataTable(
        body,
        columns,
        dimensionCount,
      );
      return {
        rows,
        rowCount: rows.length,
        database: spec.id,
        databaseTitle: spec.title,
        caveats,
        cellNotes,
        messages,
        suppressedCount,
        columns,
      };
    } finally {
      // Stamped here, not in throttle(), because WONDER measures the gap from the end of the
      // previous response — spacing from the request start fires the next call early by however
      // long the previous one took, and draws a 429. `finally` covers the failure exits too: a
      // network error, a 429, and a malformed body each still consumed a request.
      this.lastRequestTime = Date.now();
    }
  }

  /** Space consecutive requests to at least the WONDER minimum interval. Abortable via signal. */
  private async throttle(signal?: AbortSignal): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    const wait = MIN_REQUEST_INTERVAL_MS - elapsed;
    if (this.lastRequestTime !== 0 && wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, wait);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error('Aborted'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

let _service: WonderService | undefined;

export function initWonderService(): void {
  _service = new WonderService();
}

export function getWonderService(): WonderService {
  if (!_service)
    throw serviceUnavailable('WonderService not initialized — call initWonderService() in setup()');
  return _service;
}
