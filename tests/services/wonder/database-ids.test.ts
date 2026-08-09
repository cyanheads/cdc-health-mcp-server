/**
 * @fileoverview Guards the pinned CDC WONDER dataset IDs.
 *
 * The IDs are constants rather than something resolved per call, so the risk they carry is
 * silent staleness: WONDER mints a new ID per vintage for its archived datasets (cancer runs
 * D144/D151/D160/D172, TB runs D147/D156/D165), and a pinned ID that has been retired would
 * keep building requests against a dataset that no longer answers.
 *
 * The hermetic cases check the table's internal shape. The live case checks the IDs against
 * WONDER itself and is opt-in — `WONDER_LIVE_TESTS=1 bun run test` — because the rest of the
 * suite is hermetic and the default run must not depend on wonder.cdc.gov being reachable.
 * It costs no rate-limited POST: `GET /controller/datarequest/<ID>` returns a plain message
 * page naming the request page the ID belongs to, and a retired or never-allocated ID names
 * none, which is what makes the check unambiguous.
 * @module tests/services/wonder/database-ids
 */

import { describe, expect, it } from 'vitest';
import {
  WONDER_DATABASE_SPECS,
  WONDER_DATABASES,
  WONDER_DEFAULT_DATABASE,
  WONDER_YEAR_BOUNDS,
} from '@/services/wonder/types.js';

/** The request page each pinned ID resolved to when the mapping was verified. */
const REQUEST_PAGE: Record<string, string> = {
  D76: 'ucd-icd10.html',
  D158: 'ucd-icd10-expanded.html',
  D77: 'mcd-icd10.html',
  D157: 'mcd-icd10-expanded.html',
  D176: 'mcd-icd10-provisional.html',
};

/** An ID WONDER has not allocated — the negative control for the live check. */
const UNALLOCATED_ID = 'D177';

describe('WONDER database IDs', () => {
  it('pins one distinct ID per selectable database', () => {
    const ids = WONDER_DATABASES.map((d) => WONDER_DATABASE_SPECS[d].id);
    expect(ids).toEqual(['D76', 'D176', 'D158', 'D77', 'D157']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the default on D76, the database the tool queried before the selector existed', () => {
    expect(WONDER_DATABASE_SPECS[WONDER_DEFAULT_DATABASE].id).toBe('D76');
  });

  it('gives every database an ordered span inside the advertised bounds', () => {
    for (const database of WONDER_DATABASES) {
      const spec = WONDER_DATABASE_SPECS[database];
      expect(spec.firstYear).toBeLessThanOrEqual(spec.lastYear);
      expect(spec.firstYear).toBeGreaterThanOrEqual(WONDER_YEAR_BOUNDS.first);
      expect(spec.lastYear).toBeLessThanOrEqual(WONDER_YEAR_BOUNDS.last);
    }
  });

  it('runs the provisional database through the current year, since it rolls forward weekly', () => {
    expect(WONDER_DATABASE_SPECS.provisional.lastYear).toBe(new Date().getUTCFullYear());
    expect(WONDER_YEAR_BOUNDS.last).toBe(WONDER_DATABASE_SPECS.provisional.lastYear);
  });

  it('names an underlying-cause twin for exactly the redundant multiple-cause databases', () => {
    /**
     * The twin is what makes "you selected a multiple-cause database and filtered nothing"
     * worth saying. The provisional database has none — its years run past where the final
     * databases stop, so selecting it is never a no-op.
     */
    for (const database of WONDER_DATABASES) {
      const spec = WONDER_DATABASE_SPECS[database];
      if (!spec.underlyingCauseTwin) continue;
      const twin = WONDER_DATABASE_SPECS[spec.underlyingCauseTwin];
      expect(spec.multipleCause).toBe(true);
      expect(twin.multipleCause).toBe(false);
      expect(twin.firstYear).toBe(spec.firstYear);
      expect(twin.lastYear).toBe(spec.lastYear);
      expect(twin.raceVariable).toBe(spec.raceVariable);
    }
    expect(WONDER_DATABASE_SPECS.provisional.underlyingCauseTwin).toBeUndefined();
  });

  describe.skipIf(!process.env.WONDER_LIVE_TESTS)('against the live controller', () => {
    it.each(WONDER_DATABASES)('resolves %s to the request page it was mapped from', async (db) => {
      const { id } = WONDER_DATABASE_SPECS[db];
      const body = await fetch(`https://wonder.cdc.gov/controller/datarequest/${id}`).then((r) =>
        r.text(),
      );
      expect(body).toContain(REQUEST_PAGE[id]);
    });

    it('gets no request page back for an ID WONDER has not allocated', async () => {
      const body = await fetch(
        `https://wonder.cdc.gov/controller/datarequest/${UNALLOCATED_ID}`,
      ).then((r) => r.text());
      expect(body).not.toMatch(/To access data for the requested resource/);
    });
  });
});
