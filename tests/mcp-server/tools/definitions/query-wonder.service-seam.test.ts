/**
 * @fileoverview cdc_query_wonder run end to end against the real WonderService, with only
 * `fetch` faked: link rendering in both response surfaces, and the request lane under
 * concurrent tool calls.
 * @module tests/mcp-server/tools/definitions/query-wonder.service-seam
 */

import { readFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { initWonderService } from '@/services/wonder/wonder-service.js';

/** A real D158 response (race × age group, cause C00, 2024), captured from WONDER unchanged. */
const D158_RESPONSE = readFileSync(
  new URL('../../../fixtures/wonder/d158-race-age-c00-2024.response.xml', import.meta.url),
  'utf8',
);

const OK_TABLE = `<results><data-table>
  <r><c l="1999"/><c v="2,391,399"/><c v="279,040,168"/><c v="857.0"/><c v="875.6"/></r>
</data-table></results>`;

/** The interval WONDER needs between a response and the next request, written out. */
const MIN_INTERVAL_MS = 16_000;

const CONFIDENCE_LINK =
  '[More information.](https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Confidence-Intervals)';
const PRIVACY_LINK = '[More Information.](https://wonder.cdc.gov/wonder/help/faq.html#Privacy)';

function textOf(blocks: ReturnType<NonNullable<typeof queryWonder.format>>): string {
  return (blocks[0] as { type: 'text'; text: string }).text;
}

describe('cdc_query_wonder over the real service', () => {
  beforeEach(() => {
    initWonderService();
    // Nothing here may reach the live API; each test installs its own fake over this guard.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps caveat and message links in structuredContent and in content[]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(D158_RESPONSE, { status: 200 }));
    const ctx = createMockContext({ errors: queryWonder.errors });
    const input = queryWonder.input.parse({
      database: 'underlying_2018_2024',
      group_by: ['race', 'age_group'],
      cause_icd10: 'C00',
      year_range: { from: 2024, to: 2024 },
    });

    const result = await queryWonder.handler(input, ctx);
    expect(result.rowCount).toBe(4);
    expect(result.caveats).toContain(
      `The method used to calculate 95% confidence intervals is documented here: ${CONFIDENCE_LINK}`,
    );
    expect(result.messages[0]).toBe(
      `Totals are not available for these results due to suppression constraints. ${PRIVACY_LINK}`,
    );

    const text = textOf(queryWonder.format!(result));
    // Rendered as list items, unescaped, so a Markdown client shows a working link.
    expect(text).toContain(
      `- The method used to calculate 95% confidence intervals is documented here: ${CONFIDENCE_LINK}`,
    );
    expect(text).toContain(
      `- Totals are not available for these results due to suppression constraints. ${PRIVACY_LINK}`,
    );
    expect(text).toContain(
      '(https://wonder.cdc.gov/wonder/help/ucd-expanded.html#Assurance%20of%20Confidentiality)',
    );
    expect(text).not.toMatch(/onclick|setfocus|<a\b/);
  });

  it('runs two concurrent tool calls one after another, spaced from the first response', async () => {
    vi.useFakeTimers();
    const RESPONSE_MS = 1_500;
    const requestedAt: number[] = [];
    const respondedAt: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      requestedAt.push(Date.now());
      return new Promise((resolve) => {
        setTimeout(() => {
          respondedAt.push(Date.now());
          resolve(new Response(OK_TABLE, { status: 200 }));
        }, RESPONSE_MS);
      });
    });

    const calls = [
      queryWonder.handler(
        queryWonder.input.parse({ group_by: ['year'] }),
        createMockContext({ errors: queryWonder.errors }),
      ),
      queryWonder.handler(
        queryWonder.input.parse({ group_by: ['year'] }),
        createMockContext({ errors: queryWonder.errors }),
      ),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2 * RESPONSE_MS + MIN_INTERVAL_MS);
    const results = await Promise.all(calls);
    expect(results.map((r) => r.rowCount)).toEqual([1, 1]);
    expect(requestedAt).toHaveLength(2);
    expect(requestedAt[1]! - respondedAt[0]!).toBe(MIN_INTERVAL_MS);
  });
});
