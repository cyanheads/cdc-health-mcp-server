/**
 * @fileoverview Tests for analyze_health_trend prompt.
 * @module tests/mcp-server/prompts/definitions/analyze-health-trend
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { analyzeHealthTrend } from '@/mcp-server/prompts/definitions/analyze-health-trend.prompt.js';
import { discoverDatasets } from '@/mcp-server/tools/definitions/discover-datasets.tool.js';
import { getDatasetSchema } from '@/mcp-server/tools/definitions/get-dataset-schema.tool.js';
import { queryDataset } from '@/mcp-server/tools/definitions/query-dataset.tool.js';
import { queryWonder } from '@/mcp-server/tools/definitions/query-wonder.tool.js';

const TOOLS = [discoverDatasets, getDatasetSchema, queryDataset, queryWonder];

/** Text of the single message the prompt generates for the given args. */
function generate(args: Parameters<typeof analyzeHealthTrend.generate>[0]): string {
  const messages = analyzeHealthTrend.generate(args);
  return (messages[0].content as { type: 'text'; text: string }).text;
}

/** Every `properties` key and string `enum` member anywhere in a JSON Schema. */
function schemaVocabulary(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) schemaVocabulary(child, into);
    return into;
  }
  if (node === null || typeof node !== 'object') return into;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const name of Object.keys(value)) into.add(name);
    }
    if (key === 'enum' && Array.isArray(value)) {
      for (const member of value) if (typeof member === 'string') into.add(member);
    }
    schemaVocabulary(value, into);
  }
  return into;
}

/** Tool names plus every input/output field name and enum member across the tool surface. */
const TOOL_VOCABULARY = (() => {
  const vocabulary = new Set<string>(TOOLS.map((t) => t.name));
  for (const t of TOOLS) {
    schemaVocabulary(z.toJSONSchema(t.input), vocabulary);
    schemaVocabulary(z.toJSONSchema(t.output), vocabulary);
  }
  return vocabulary;
})();

/** WONDER's year bounds as the tool actually enforces them, read off its input schema. */
const WONDER_YEARS = (() => {
  const schema = z.toJSONSchema(queryWonder.input) as {
    properties: {
      year_range: { properties: { from: { minimum: number }; to: { maximum: number } } };
    };
  };
  const { from, to } = schema.properties.year_range.properties;
  return { first: from.minimum, last: to.maximum };
})();

/** Lowercase-initial identifiers the prompt wraps in backticks — i.e. names it borrows. */
function backtickedIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((token) => /^[a-z][A-Za-z0-9_]*$/.test(token));
}

describe('analyze_health_trend', () => {
  it('generates a message with the topic', () => {
    const args = analyzeHealthTrend.args.parse({ topic: 'diabetes mortality trends' });
    const messages = analyzeHealthTrend.generate(args);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const text = (messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('diabetes mortality trends');
    expect(text).toContain('Discover');
    expect(text).toContain('Inspect');
    expect(text).toContain('Baseline');
    expect(text).toContain('Compare');
    expect(text).toContain('Synthesize');
  });

  it('includes time range when provided', () => {
    const args = analyzeHealthTrend.args.parse({
      topic: 'opioid overdose deaths',
      timeRange: '2015-2023',
    });
    const messages = analyzeHealthTrend.generate(args);
    const text = (messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('2015-2023');
  });

  it('includes geography when provided', () => {
    const args = analyzeHealthTrend.args.parse({
      topic: 'vaccination coverage',
      geography: 'California',
    });
    const messages = analyzeHealthTrend.generate(args);
    const text = (messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('California');
  });

  it('defaults to national level when geography omitted', () => {
    const args = analyzeHealthTrend.args.parse({ topic: 'flu trends' });
    const messages = analyzeHealthTrend.generate(args);
    const text = (messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('national level');
  });

  it('requires topic', () => {
    expect(() => analyzeHealthTrend.args.parse({})).toThrow();
  });

  describe('source routing', () => {
    /**
     * Nothing typechecks a prompt against the tools it instructs a client to call, so a
     * renamed field or a mistyped tool name ships silently. Every backticked identifier
     * has to resolve against the live tool surface.
     */
    it('borrows only names the tool surface actually exposes', () => {
      const args = analyzeHealthTrend.args.parse({
        topic: 'national heart disease mortality trends',
        timeRange: '2015-2020',
        geography: 'national',
      });
      const borrowed = backtickedIdentifiers(generate(args));

      expect(borrowed.length).toBeGreaterThan(0);
      expect(borrowed.filter((name) => !TOOL_VOCABULARY.has(name))).toEqual([]);
    });

    it('names every tool the workflow prescribes', () => {
      const text = generate(analyzeHealthTrend.args.parse({ topic: 'heart disease deaths' }));
      for (const t of TOOLS) expect(text).toContain(t.name);
    });

    it('routes a national mortality question to WONDER within the years it holds', () => {
      const args = analyzeHealthTrend.args.parse({
        topic: 'national heart disease mortality trends',
        timeRange: '2015-2020',
        geography: 'national',
      });
      const wonderGuidance = generate(args)
        .split('\n')
        .find((line) => line.startsWith('- `cdc_query_wonder`'));

      expect(wonderGuidance).toBeDefined();
      expect(wonderGuidance).toContain('national scope');
      // The span the prompt advertises has to be the span the tool accepts.
      expect(wonderGuidance).toContain(`${WONDER_YEARS.first}–${WONDER_YEARS.last}`);
      // The sub-national limit is upstream policy and holds on every database — the prompt
      // must not let a reader take the database selector for a way around it.
      expect(wonderGuidance).toContain('no sub-national breakdown');
      expect(wonderGuidance).toContain('database');
    });

    it('tells the reader the era and record type are a database choice, not a tool choice', () => {
      /**
       * Recency and multiple-cause both live behind `database`. A reader who reads WONDER as
       * one fixed span routes current-year mortality to Socrata, which does not hold it in
       * this shape, and never reaches the multiple-cause filter at all.
       */
      const wonderGuidance = generate(analyzeHealthTrend.args.parse({ topic: 'overdose deaths' }))
        .split('\n')
        .find((line) => line.startsWith('- `cdc_query_wonder`'));

      expect(wonderGuidance).toContain('provisional');
      expect(wonderGuidance).toContain('mcd_icd10');
    });

    it('routes a sub-national or non-mortality question to the Socrata catalog', () => {
      const args = analyzeHealthTrend.args.parse({
        topic: 'childhood vaccination coverage by state',
        timeRange: '2021-2024',
        geography: 'all states',
      });
      const socrataGuidance = generate(args)
        .split('\n')
        .find((line) => line.startsWith('- `cdc_discover_datasets`'));

      expect(socrataGuidance).toBeDefined();
      expect(socrataGuidance).toContain('cdc_get_dataset_schema');
      expect(socrataGuidance).toContain('cdc_query_dataset');
      expect(socrataGuidance).toContain('state or county detail');
      expect(socrataGuidance).toContain('non-mortality');
      // Years are no longer what separates the two systems — WONDER runs to the current year,
      // so a routing rule keyed on "after <year>" would send current mortality the wrong way.
      expect(socrataGuidance).not.toMatch(/years after \d{4}/);
    });

    it('keeps the branch as guidance rather than classifying the topic', () => {
      /**
       * The handler must not decide the source — a caller reading the prompt does. The
       * same guidance therefore has to reach a mortality topic and a vaccination one.
       */
      const mortality = generate(
        analyzeHealthTrend.args.parse({ topic: 'heart disease deaths', geography: 'national' }),
      );
      const vaccination = generate(
        analyzeHealthTrend.args.parse({ topic: 'HPV vaccination coverage', geography: 'Ohio' }),
      );
      const guidanceOf = (text: string) => text.split('\n').filter((l) => l.startsWith('- `'));

      expect(guidanceOf(mortality)).toEqual(guidanceOf(vaccination));
      expect(guidanceOf(mortality)).toHaveLength(2);
    });
  });
});
