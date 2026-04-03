/**
 * @fileoverview Tests for analyze_health_trend prompt.
 * @module tests/mcp-server/prompts/definitions/analyze-health-trend
 */

import { describe, expect, it } from 'vitest';
import { analyzeHealthTrend } from '@/mcp-server/prompts/definitions/analyze-health-trend.prompt.js';

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
});
