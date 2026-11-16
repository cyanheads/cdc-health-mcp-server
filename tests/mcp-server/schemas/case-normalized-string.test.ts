/**
 * @fileoverview caseNormalizedString, the letter-case fold behind every ICD-10 code and dataset
 * ID input: which values it rewrites, which it leaves for the pattern to reject, the
 * CDC_NORMALIZE_INPUT_CASE switch, the log line and counter a rewrite writes, and its cost over
 * caller-sized text — and the definition and field each real input's rewrites are counted under.
 * The definitions' own tests cover only their wiring.
 * @module tests/mcp-server/schemas/case-normalized-string
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { type Meter, metrics } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { datasetDetailResource } from '@/mcp-server/resources/definitions/dataset-detail.resource.js';
import { caseNormalizedString } from '@/mcp-server/schemas/case-normalized-string.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';
import { expectLinearDoublings, fill } from '../../helpers/cpu-cost.js';

const { config } = vi.hoisted(() => ({ config: { normalizeInputCase: true } }));

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

/** The ICD-10 and four-by-four patterns the definitions advertise, written out. */
const ICD10 = /^[A-Z][0-9]{2}(\.[0-9]+)?(-[A-Z][0-9]{2}(\.[0-9]+)?)?$/;
const DATASET_ID = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

const ICD10_ERROR = 'Expected an ICD-10 code such as "I21" or a tree-node range such as "X40-X49".';
const DATASET_ID_ERROR = 'Expected a four-by-four ID such as "bi63-dtpu".';

/** One schema per letter case, built as the definitions build theirs. */
const schemas = {
  icd10: caseNormalizedString({
    definition: 'cdc_query_wonder',
    error: ICD10_ERROR,
    field: 'cause_icd10',
    letterCase: 'upper',
    pattern: ICD10,
  }),
  datasetId: caseNormalizedString({
    definition: 'cdc_get_dataset_schema',
    error: DATASET_ID_ERROR,
    field: 'datasetId',
    letterCase: 'lower',
    pattern: DATASET_ID,
  }),
};
type Kind = keyof typeof schemas;

const PATTERN: Record<Kind, RegExp> = { icd10: ICD10, datasetId: DATASET_ID };
const ERROR: Record<Kind, string> = { icd10: ICD10_ERROR, datasetId: DATASET_ID_ERROR };

/** One counter increment as the meter received it. */
interface Recorded {
  attributes: unknown;
  name: string;
  value: number;
}

let recorded: Recorded[];
let info: MockInstance<typeof logger.info>;

/**
 * Registers a global meter provider whose counters record into `recorded` — the provider the
 * framework's `createCounter` resolves its instrument from on every add.
 */
function recordMetrics(): void {
  recorded = [];
  const meter = {
    createCounter: (name: string) => ({
      add: (value: number, attributes?: unknown) => recorded.push({ name, value, attributes }),
    }),
  } as unknown as Meter;
  metrics.setGlobalMeterProvider({ getMeter: () => meter });
}

beforeEach(() => {
  config.normalizeInputCase = true;
  recordMetrics();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  metrics.disable();
  vi.restoreAllMocks();
});

describe('caseNormalizedString', () => {
  it.each<[Kind, string]>([
    ['icd10', 'I21'],
    ['icd10', 'X40-X49'],
    ['icd10', 'V01-Y89'],
    ['icd10', 'T40.1'],
    ['icd10', 'T40.1-T40.4'],
    ['datasetId', 'bi63-dtpu'],
    ['datasetId', '1234-5678'],
    ['datasetId', 'abcd-efgh'],
  ])('%s passes %j through unchanged, reporting no rewrite', (kind, value) => {
    expect(schemas[kind].parse(value)).toBe(value);
    expect(info).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it.each<[Kind, string, string]>([
    ['icd10', 'i21', 'I21'],
    ['icd10', 'x40-x49', 'X40-X49'],
    ['icd10', 'X40-x49', 'X40-X49'],
    ['icd10', 't40.1', 'T40.1'],
    ['icd10', 'c00-d48', 'C00-D48'],
    ['datasetId', 'BI63-DTPU', 'bi63-dtpu'],
    ['datasetId', 'Bi63-dTpu', 'bi63-dtpu'],
    ['datasetId', 'ABCD-1234', 'abcd-1234'],
  ])('%s folds %j to %j', (kind, sent, normalized) => {
    expect(schemas[kind].parse(sent)).toBe(normalized);
  });

  it.each<[Kind, string]>([
    ['icd10', 'X4-X49'],
    ['icd10', 'x4-x49'],
    ['icd10', 'I00-'],
    ['icd10', 'I21<script>'],
    ['icd10', ' I21'],
    ['icd10', ''],
    // Letters whose toUpperCase() is an ASCII letter: folding them would accept a new value.
    ['icd10', 'ı21'],
    ['icd10', 'ſ00'],
    ['icd10', 'Ｉ21'],
    ['datasetId', 'ab12-cd3'],
    ['datasetId', 'bi63_dtpu'],
    ['datasetId', '../etc/passwd'],
    // The Kelvin sign (U+212A), whose toLowerCase() is "k", and a dotted capital I.
    ['datasetId', 'Kab1-cd34'],
    ['datasetId', 'İb12-cd34'],
  ])('%s rejects %j, naming the expected form', (kind, value) => {
    const parsed = schemas[kind].safeParse(value);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        code: 'invalid_format',
        format: 'regex',
        pattern: String(PATTERN[kind]),
        message: ERROR[kind],
      }),
    ]);
    expect(info).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('logs one line and counts once, by definition and field, for a value the fold made valid', () => {
    expect(schemas.icd10.parse('x40-x49')).toBe('X40-X49');

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]?.extra).toEqual({
      definition: 'cdc_query_wonder',
      field: 'cause_icd10',
      sent: 'x40-x49',
      normalized: 'X40-X49',
    });
    expect(recorded).toEqual([
      {
        name: 'cdc.input.case_normalized',
        value: 1,
        attributes: {
          'cdc.input.definition': 'cdc_query_wonder',
          'cdc.input.field': 'cause_icd10',
        },
      },
    ]);
  });

  it('labels a dataset ID rewrite with its own definition and field, never the value', () => {
    schemas.datasetId.parse('BI63-DTPU');
    expect(recorded.map((r) => r.attributes)).toEqual([
      { 'cdc.input.definition': 'cdc_get_dataset_schema', 'cdc.input.field': 'datasetId' },
    ]);
  });

  /** Each definition builds its own schema, so its labels are read through the schema it advertises. */
  it.each<[string, string, string, string, (value: string) => unknown]>([
    [
      'cdc_get_dataset_schema',
      'datasetId',
      'BI63-DTPU',
      'bi63-dtpu',
      (value) => getDatasetSchema.input.parse({ datasetId: value }).datasetId,
    ],
    [
      'cdc_query_dataset',
      'datasetId',
      'BI63-DTPU',
      'bi63-dtpu',
      (value) => queryDataset.input.parse({ datasetId: value }).datasetId,
    ],
    [
      'cdc://datasets/{datasetId}',
      'datasetId',
      'BI63-DTPU',
      'bi63-dtpu',
      (value) => datasetDetailResource.params?.parse({ datasetId: value }).datasetId,
    ],
    [
      'cdc_query_wonder',
      'cause_icd10',
      'x40-x49',
      'X40-X49',
      (value) => queryWonder.input.parse({ group_by: ['year'], cause_icd10: value }).cause_icd10,
    ],
    [
      'cdc_query_wonder',
      'mcd_icd10',
      'x40-x49',
      'X40-X49',
      (value) => queryWonder.input.parse({ group_by: ['year'], mcd_icd10: value }).mcd_icd10,
    ],
  ])(
    'counts a %s %s rewrite under that definition and field',
    (definition, field, sent, normalized, parse) => {
      expect(parse(sent)).toBe(normalized);
      expect(recorded).toEqual([
        {
          name: 'cdc.input.case_normalized',
          value: 1,
          attributes: { 'cdc.input.definition': definition, 'cdc.input.field': field },
        },
      ]);
    },
  );

  describe('with CDC_NORMALIZE_INPUT_CASE off', () => {
    beforeEach(() => {
      config.normalizeInputCase = false;
    });

    it.each<[Kind, string]>([
      ['icd10', 'x40-x49'],
      ['icd10', 'i21'],
      ['datasetId', 'BI63-DTPU'],
    ])('%s rejects %j as before, logging and counting nothing', (kind, value) => {
      expect(schemas[kind].safeParse(value).error?.issues[0]?.message).toBe(ERROR[kind]);
      expect(info).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });

    it('still accepts a value already in the advertised case', () => {
      expect(schemas.icd10.parse('X40-X49')).toBe('X40-X49');
      expect(schemas.datasetId.parse('bi63-dtpu')).toBe('bi63-dtpu');
    });
  });

  it('reads the switch on each parse, not when the schema was built', () => {
    config.normalizeInputCase = false;
    expect(schemas.icd10.safeParse('i21').success).toBe(false);
    config.normalizeInputCase = true;
    expect(schemas.icd10.parse('i21')).toBe('I21');
  });

  /**
   * Timing: the value is the caller's, so its length is bounded only by the request body. Each
   * shape doubles from 5,000 characters to 320,000, and at every size the least of several
   * measurements stays under four times the growth against the 5,000-character base re-timed
   * beside it — under 256× at the full 64× span. The digit run is a valid code the fold rewrites,
   * so it times the scan, the fold, and both pattern checks together.
   */
  describe('timing', () => {
    it.each<[string, Kind, (n: number) => string]>([
      ['one long line ending in a break', 'icd10', (n) => `${fill('§1 x', n)}\ny`],
      ['line breaks throughout', 'icd10', (n) => fill('  \r\n', n)],
      ['one long run of letters to fold', 'icd10', (n) => fill('x', n)],
      ['a valid code with a long digit run', 'icd10', (n) => `i21.${fill('1', n)}`],
      ['a long run of letters to lowercase', 'datasetId', (n) => fill('AB', n)],
    ])(
      'stays linear on %s',
      (_name, kind, build) =>
        expectLinearDoublings(build, 320_000, (input) => schemas[kind].safeParse(input), 50),
      0,
    );
  });
});
