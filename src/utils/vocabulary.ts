/**
 * @fileoverview Token matching over the catalog's controlled vocabularies — the one rule
 * behind `cdc_list_catalog_vocabulary`'s filter and `cdc_discover_datasets`' near-miss notice.
 * @module utils/vocabulary
 */

import type { VocabularyTerm } from '@/services/socrata/types.js';

/**
 * Shortest filter worth matching on, counted in alphanumeric characters. Below it a
 * containment test stops discriminating: "a" is a substring of most of the 1,583 tags, so
 * every value would qualify and the ranking would carry no signal.
 */
export const MIN_FILTER_LENGTH = 3;

/**
 * Shortest token that may match by containment rather than equality. The same floor as the
 * filter, applied per token: without it the two-letter tokens real vocabulary values carry
 * ("covid-19", "hiv/aids") would relate to any word containing them.
 */
const MIN_TOKEN_LENGTH = 3;

/** Whether two tokens name the same thing — one contains the other, or they are equal. */
function related(a: string, b: string): boolean {
  if (a.length < MIN_TOKEN_LENGTH || b.length < MIN_TOKEN_LENGTH) return a === b;
  return a.includes(b) || b.includes(a);
}

/**
 * Fold a vocabulary value or a caller's filter into comparable tokens: lowercase, accents
 * dropped, every run of non-alphanumeric characters treated as a separator. The catalog's own
 * values mix spaces, hyphens, ampersands, and commas — "Maternal &amp; Child Health",
 * "covid-19", "Pregnancy &amp; Vaccination" — so comparing raw text misses on punctuation the
 * caller had no way to guess.
 */
export function vocabularyTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether `value` carries enough alphanumeric characters for `matchVocabulary` to
 * discriminate. Below the floor the matcher answers nothing, which two callers read
 * differently: a near-miss lookup has no candidate to name, while a filter is ignored and the
 * whole vocabulary returned. Exported so the ignoring caller states the rule by asking rather
 * than by restating the threshold.
 */
export function isDiscriminatingFilter(value: string): boolean {
  return vocabularyTokens(value).join('').length >= MIN_FILTER_LENGTH;
}

/**
 * The vocabulary values related to `value`, in the order they were given.
 *
 * A value qualifies when every token on one side is related to some token on the other — in
 * either direction, because the two cover different mistakes. Forward covers a caller less
 * specific than the vocabulary ("Vaccination" → "Vaccinations", "Child Vaccinations");
 * reverse covers one who was more specific ("nndss weekly" → "nndss").
 *
 * Deliberately not fuzzy: relatedness is containment, so a transposed or misspelled filter
 * resolves to nothing rather than to a confident wrong answer. Ranking is inherited from
 * `terms`, which the service returns sorted by dataset count, so an optional `limit` takes
 * the most-used matches; omit it to keep every match.
 */
export function matchVocabulary(
  terms: readonly VocabularyTerm[],
  value: string,
  limit?: number,
): VocabularyTerm[] {
  if (!isDiscriminatingFilter(value)) return [];
  const filter = vocabularyTokens(value);

  const matched = terms.filter(({ value: term }) => {
    const tokens = vocabularyTokens(term);
    if (tokens.length === 0) return false;
    return (
      filter.every((f) => tokens.some((t) => related(f, t))) ||
      tokens.every((t) => filter.some((f) => related(f, t)))
    );
  });

  return limit === undefined ? matched : matched.slice(0, limit);
}
