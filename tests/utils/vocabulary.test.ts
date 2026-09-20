/**
 * @fileoverview Tests for the catalog vocabulary matcher.
 * @module tests/utils/vocabulary
 */

import { describe, expect, it } from 'vitest';
import type { VocabularyTerm } from '@/services/socrata/types.js';
import { matchVocabulary, vocabularyTokens } from '@/utils/vocabulary.js';

/** Live `data.cdc.gov` values, count-ranked as the service returns them. */
const CATEGORIES: VocabularyTerm[] = [
  { value: 'NNDSS', datasetCount: 295 },
  { value: 'National Center for Health Statistics', datasetCount: 287 },
  { value: 'Vaccinations', datasetCount: 89 },
  { value: 'Motor Vehicle', datasetCount: 45 },
  { value: 'Environmental Health & Toxicology', datasetCount: 21 },
  { value: 'Maternal & Child Health', datasetCount: 21 },
  { value: 'Child Vaccinations', datasetCount: 15 },
  { value: 'Flu Vaccinations', datasetCount: 13 },
  { value: 'Pregnancy & Vaccination', datasetCount: 10 },
];

const values = (terms: VocabularyTerm[]) => terms.map((t) => t.value);

describe('vocabularyTokens', () => {
  it('splits on the punctuation catalog values actually carry', () => {
    expect(vocabularyTokens('Maternal & Child Health')).toEqual(['maternal', 'child', 'health']);
    expect(vocabularyTokens('covid-19 vaccination')).toEqual(['covid', '19', 'vaccination']);
    expect(vocabularyTokens('500 Cities & Places')).toEqual(['500', 'cities', 'places']);
  });

  it('folds case and accents so a value is compared on its letters', () => {
    expect(vocabularyTokens('Données')).toEqual(['donnees']);
    expect(vocabularyTokens('NNDSS')).toEqual(['nndss']);
  });

  it('yields no tokens for text with nothing to match on', () => {
    expect(vocabularyTokens('   —  ')).toEqual([]);
    expect(vocabularyTokens('')).toEqual([]);
  });
});

describe('matchVocabulary', () => {
  it('resolves a filter less specific than the vocabulary', () => {
    // The issue's case: "Vaccination" returns nothing from the catalog, "Vaccinations" 89.
    expect(values(matchVocabulary(CATEGORIES, 'Vaccination', 3))).toEqual([
      'Vaccinations',
      'Child Vaccinations',
      'Flu Vaccinations',
    ]);
  });

  it('resolves a filter more specific than the vocabulary', () => {
    expect(values(matchVocabulary(CATEGORIES, 'NNDSS weekly tables', 3))).toEqual(['NNDSS']);
  });

  it('resolves a plural filter against a singular value', () => {
    /** Containment has to run in both directions, or one of the two spellings misses. */
    const tags: VocabularyTerm[] = [{ value: 'vaccination', datasetCount: 41 }];
    expect(values(matchVocabulary(tags, 'vaccinations', 3))).toEqual(['vaccination']);
  });

  it('matches across the punctuation between words', () => {
    const tags: VocabularyTerm[] = [{ value: 'covid-19 vaccination', datasetCount: 35 }];
    expect(values(matchVocabulary(tags, 'covid 19', 3))).toEqual(['covid-19 vaccination']);
  });

  it('keeps the caller-ranked order and honours the limit', () => {
    const hits = matchVocabulary(CATEGORIES, 'vaccin', 2);
    expect(values(hits)).toEqual(['Vaccinations', 'Child Vaccinations']);
    // Ranking is inherited from the input order, which the service sorts by count.
    expect(hits.map((h) => h.datasetCount)).toEqual([89, 15]);
  });

  it('returns nothing for a misspelling rather than guessing', () => {
    /**
     * The alternative — edit-distance correction — commits the caller to a value they did not
     * type. Returning nothing lets them see the vocabulary and choose.
     */
    for (const typo of ['Vacination', 'Vaccinatoins', 'Zzznotacategory']) {
      expect(matchVocabulary(CATEGORIES, typo, 3)).toEqual([]);
    }
  });

  it('ignores a filter too short to discriminate', () => {
    /**
     * "a" is inside most of the 1,583 live tags, so containment on it returns the whole
     * vocabulary dressed as a match — a result that reads as signal and carries none.
     */
    expect(matchVocabulary(CATEGORIES, 'a', 3)).toEqual([]);
    expect(matchVocabulary(CATEGORIES, 'NN', 3)).toEqual([]);
    expect(matchVocabulary(CATEGORIES, '   ', 3)).toEqual([]);
  });

  it('does not let a short vocabulary token match everything', () => {
    /**
     * The reverse direction would otherwise relate a two-letter value to any word containing
     * those letters — "hi" to "Child Health" — and put it at the top of a near-miss notice.
     */
    const terms: VocabularyTerm[] = [
      { value: 'hi', datasetCount: 900 },
      { value: 'child health', datasetCount: 12 },
    ];
    expect(values(matchVocabulary(terms, 'child health', 3))).toEqual(['child health']);
  });

  it('leaves unrelated values out, so "closest" carries meaning', () => {
    const hits = values(matchVocabulary(CATEGORIES, 'Vaccination', 9));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).not.toContain('Motor Vehicle');
    expect(hits).not.toContain('National Center for Health Statistics');
  });

  it('returns nothing from an empty vocabulary', () => {
    expect(matchVocabulary([], 'Vaccination', 3)).toEqual([]);
  });

  it('skips a value with no matchable characters instead of treating it as a wildcard', () => {
    const terms: VocabularyTerm[] = [{ value: '—', datasetCount: 5 }];
    expect(matchVocabulary(terms, 'Vaccination', 3)).toEqual([]);
  });
});
