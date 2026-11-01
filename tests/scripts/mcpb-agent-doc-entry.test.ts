/**
 * @fileoverview The bundle cleaner and the packaging check select the same dependency agent-doc
 * entries, and neither selects the MCP SDK's Skills extension runtime under `dist/ext/skills/`.
 * @module tests/scripts/mcpb-agent-doc-entry
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

interface PackagingLinter {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: a literal specifier would pull `scripts/lint-packaging.ts` into the
 * `tsc` program, and its repo-only fallback import does not resolve here
 * (cyanheads/mcp-ts-core#797).
 */
const linterUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const linter: PackagingLinter = await import(linterUrl);

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'skills/example-guide/SKILL.md',
];

const agentDocs = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/thread-stream/.claude/settings.local.json',
  'node_modules/example/.agents/guide.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/guide.md',
  'node_modules/example/docs/SKILL.md',
];

describe('MCPB agent-doc entries', () => {
  it.each(runtimeEntries)('keeps runtime or published entry %s', (entry) => {
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(false);
    expect(linter.AGENT_DOC_ENTRY.test(entry)).toBe(false);
  });

  it.each(agentDocs)('strips dependency agent doc %s', (entry) => {
    expect(AGENT_DOC_ENTRY.test(entry)).toBe(true);
    expect(linter.AGENT_DOC_ENTRY.test(entry)).toBe(true);
  });

  it('selects exactly the agent docs from a mixed listing', () => {
    expect(filterAgentDocEntries([...runtimeEntries, ...agentDocs])).toEqual(agentDocs);
  });

  it('keeps the cleaner and the packaging check on one selector', () => {
    expect(linter.AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
    expect(linter.AGENT_DOC_ENTRY.flags).toBe(AGENT_DOC_ENTRY.flags);
  });

  it('passes a cleaned bundle that still carries the SDK skills runtime', () => {
    expect(linter.checkBundleEntries(runtimeEntries, 'dist/test.mcpb')).toEqual([]);
    const [error] = linter.checkBundleEntries([...runtimeEntries, ...agentDocs], 'dist/test.mcpb');
    expect(error).toContain(`contains ${agentDocs.length} node_modules agent-doc entries`);
  });
});
