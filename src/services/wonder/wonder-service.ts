/**
 * @fileoverview CDC WONDER mortality API client (database D76, Underlying Cause of Death).
 * Builds an XML request, POSTs it form-urlencoded to the WONDER controller, and parses the
 * `<data-table>` response into keyed rows.
 *
 * Two live-API constraints are handled here:
 *  - WONDER sits behind an Akamai bot filter that blocks browser-*claiming* clients (a browser
 *    UA + Origin/Referer with a non-browser TLS fingerprint → 403). Requests are sent with only
 *    a Content-Type header — an honest programmatic client passes.
 *  - The API enforces a hard 15-second gap between requests (429 otherwise), so calls are spaced.
 * @module services/wonder/wonder-service
 */

import { rateLimited, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { WONDER_DATABASE_ID, type WonderQueryOptions, type WonderResult } from './types.js';
import { buildRequestXml } from './xml-builder.js';
import { parseDataTable } from './xml-parser.js';

/** WONDER is always this host — not configurable (unlike Socrata's multi-portal reality). */
const WONDER_BASE_URL = 'https://wonder.cdc.gov';

/** WONDER requires ≥ 15 s between API requests; it returns 429 otherwise. */
const MIN_REQUEST_INTERVAL_MS = 15_000;

/** Extract the first `<message>` from an error response body (WONDER states the reason there). */
function firstMessage(body: string): string | undefined {
  const inner = body.match(/<message[^>]*>([\s\S]*?)<\/message>/)?.[1];
  if (inner === undefined) return;
  return inner
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class WonderService {
  private lastRequestTime = 0;

  /**
   * Run a D76 mortality query. Builds the request XML, spaces the request to respect the
   * WONDER rate limit, POSTs it, and parses the response into keyed rows.
   */
  async query(options: WonderQueryOptions, signal?: AbortSignal): Promise<WonderResult> {
    const { xml, columns, dimensionCount } = buildRequestXml(options);
    await this.throttle(signal);

    let response: Response;
    try {
      response = await globalThis.fetch(
        `${WONDER_BASE_URL}/controller/datarequest/${WONDER_DATABASE_ID}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ request_xml: xml, accept_datause_restrictions: 'true' }),
          signal: signal ?? null,
        },
      );
    } catch (err) {
      throw serviceUnavailable('Failed to reach the CDC WONDER API. Retry after a brief delay.', {
        reason: 'upstream_error',
        cause: (err as Error).message,
      });
    }

    const body = await response.text().catch(() => '');

    if (response.status === 429) {
      throw rateLimited(
        'CDC WONDER rate limit hit — the API requires at least 15 seconds between requests. Retry after a short pause.',
        { reason: 'rate_limited' },
      );
    }
    if (!response.ok || body.includes('Access Denied')) {
      const message = firstMessage(body);
      // WONDER reports malformed-request problems in <message> with a 400/500; surface it as a
      // validation error so the agent can correct the query. A bodyless failure is infrastructure.
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
      const message = firstMessage(body);
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
      database: WONDER_DATABASE_ID,
      caveats,
      cellNotes,
      suppressedCount,
      columns,
    };
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
    this.lastRequestTime = Date.now();
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
