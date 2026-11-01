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

  describe('a filter under three letters or digits', () => {
    /**
     * Live `data.cdc.gov` values that carry `tb`, `h5`, or `19` — as a whole word or inside
     * one — plus the one category naming TB, count-ranked as the service returns them.
     */
    const SHORT_TERMS: VocabularyTerm[] = [
      { value: 'covid-19', datasetCount: 178 },
      { value: 'outbreak', datasetCount: 9 },
      {
        value: 'National Center for HIV, Viral Hepatitis, STD, and TB Prevention',
        datasetCount: 7,
      },
      { value: 'tb', datasetCount: 6 },
      { value: 'tbi', datasetCount: 4 },
      { value: 'tuberculosis (tb)', datasetCount: 3 },
      { value: 'latent tuberculosis infection (ltbi)', datasetCount: 2 },
      { value: 'avian influenza a (h5)', datasetCount: 1 },
      { value: 'h5', datasetCount: 1 },
      { value: 'h5n1', datasetCount: 1 },
      { value: 't-spot.tb (tspot)', datasetCount: 1 },
    ];

    /**
     * Containment on a one- or two-character filter would carry no signal — "a" is inside most
     * of the ~1,600 live tags — so a short filter matches a value only where one of the value's
     * own words equals it after folding. `tb` reaches "tuberculosis (tb)" and never "outbreak",
     * "tbi", or "ltbi"; a filter with no letters or digits has no word to match and reaches
     * nothing, where `[].every` would otherwise admit every value.
     */
    it.each([
      {
        filter: 'TB',
        matched: [
          'National Center for HIV, Viral Hepatitis, STD, and TB Prevention',
          'tb',
          'tuberculosis (tb)',
          't-spot.tb (tspot)',
        ],
      },
      {
        filter: 'tb',
        matched: [
          'National Center for HIV, Viral Hepatitis, STD, and TB Prevention',
          'tb',
          'tuberculosis (tb)',
          't-spot.tb (tspot)',
        ],
      },
      { filter: 'h5', matched: ['avian influenza a (h5)', 'h5'] },
      { filter: '19', matched: ['covid-19'] },
      {
        filter: ' (TB) ',
        matched: [
          'National Center for HIV, Viral Hepatitis, STD, and TB Prevention',
          'tb',
          'tuberculosis (tb)',
          't-spot.tb (tspot)',
        ],
      },
      { filter: 'zq', matched: [] },
      { filter: 'h', matched: [] },
      { filter: '--', matched: [] },
      { filter: '   ', matched: [] },
      { filter: '', matched: [] },
    ])('$filter matches $matched', ({ filter, matched }) => {
      expect(values(matchVocabulary(SHORT_TERMS, filter))).toEqual(matched);
    });

    it('matches no prefix: "NN" does not reach "NNDSS", nor "a" a word starting with it', () => {
      expect(matchVocabulary(CATEGORIES, 'NN', 3)).toEqual([]);
      expect(matchVocabulary(CATEGORIES, 'a', 3)).toEqual([]);
    });

    it('keeps the caller-ranked order and honours the limit', () => {
      expect(values(matchVocabulary(SHORT_TERMS, 'tb', 2))).toEqual([
        'National Center for HIV, Viral Hepatitis, STD, and TB Prevention',
        'tb',
      ]);
    });
  });

  it('keeps containment for a filter of three or more letters', () => {
    /** At the floor a token relates by containment again: "tub" reaches every tuberculosis tag. */
    const terms: VocabularyTerm[] = [
      { value: 'tuberculosis (tb)', datasetCount: 3 },
      { value: 'latent tuberculosis infection (ltbi)', datasetCount: 2 },
      { value: 'tb', datasetCount: 6 },
    ];
    expect(values(matchVocabulary(terms, 'tub'))).toEqual([
      'tuberculosis (tb)',
      'latent tuberculosis infection (ltbi)',
    ]);
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
