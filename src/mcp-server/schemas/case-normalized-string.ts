/**
 * @fileoverview A string input whose letter case is folded before its pattern check, for
 * identifiers whose case carries no meaning: ICD-10 codes and four-by-four dataset IDs.
 * @module mcp-server/schemas/case-normalized-string
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createCounter, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const caseNormalized = createCounter(
  'cdc.input.case_normalized',
  'Input values accepted after their letter case was folded to the form the pattern takes',
  '{values}',
);

/**
 * Printable ASCII, the only text folded. `toUpperCase()` and `toLowerCase()` map letters outside
 * it onto ASCII ones — `ı` to `I`, `ſ` to `S`, the Kelvin sign to `k` — so folding those would
 * turn values rejected today into valid ones; left as sent, they still fail the pattern.
 */
const PRINTABLE_ASCII = /^[ -~]*$/;

/** What one case-normalized input is, and how it reports a rewrite. */
export interface CaseNormalizedStringOptions {
  /** Tool name or resource URI template: a counter label, so never caller text. */
  definition: string;
  /** Rejection message for a value that fails `pattern` after folding. */
  error: string;
  /** Input field name: a counter label, so never caller text. */
  field: string;
  /** The case `pattern` takes. */
  letterCase: 'lower' | 'upper';
  /** The advertised pattern, applied to the folded value. */
  pattern: RegExp;
}

/**
 * `z.string()` with the value's ASCII letters folded to `letterCase`, then checked against
 * `pattern`. `.overwrite()` adds nothing to the emitted JSON Schema, so the advertised `pattern`
 * is unchanged and a value of the advertised case reaches the handler as sent.
 *
 * `CDC_NORMALIZE_INPUT_CASE` is read on every parse rather than when the schema is built: the
 * schema is built at import, before `createApp()` loads `.env`. A fold that turns a value valid
 * logs one `info` line and adds 1 to `cdc.input.case_normalized`. Both run on each parse of
 * the arguments, so a call the framework repairs and parses again counts its value twice.
 */
export function caseNormalizedString({
  definition,
  error,
  field,
  letterCase,
  pattern,
}: CaseNormalizedStringOptions) {
  return z
    .string()
    .overwrite((value) => {
      if (!getServerConfig().normalizeInputCase || !PRINTABLE_ASCII.test(value)) return value;
      const folded = letterCase === 'upper' ? value.toUpperCase() : value.toLowerCase();
      if (folded !== value && pattern.test(folded)) {
        logger.info(
          'Folded the letter case of an input value',
          requestContextService.createRequestContext({
            operation: 'caseNormalizedString',
            additionalContext: { definition, field, sent: value, normalized: folded },
          }),
        );
        caseNormalized.add(1, { 'cdc.input.definition': definition, 'cdc.input.field': field });
      }
      return folded;
    })
    .regex(pattern, { error });
}
