/**
 * @fileoverview tests/scripts/bundle-agent-docs.test.ts — the `.mcpb` cleaner
 * and packaging check keep executable dependency modules under a nested
 * `skills/` directory (the MCP SDK's `dist/ext/skills/` runtime) while stripping
 * agent documentation at a dependency's package root.
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

// Loaded by URL so `tsc` never follows the script's repo-only fallback import.
const {
  checkBundleEntries,
}: { checkBundleEntries: (entries: string[], bundleLabel: string) => string[] } = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

describe('bundle agent-doc boundaries', () => {
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/runtime/dist/skills/index.js',
    'node_modules/@scope/skills/index.js',
    'skills/clipboard-guide/SKILL.md',
  ])('keeps runtime or published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each([
    'node_modules/package/skills/guide/SKILL.md',
    'node_modules/@scope/package/framework-skills/guide/SKILL.md',
    'node_modules/outer/node_modules/@scope/package/skills/guide/reference.md',
    'node_modules/outer/node_modules/package/.claude/settings.json',
    'node_modules/package/.agents/guide.md',
    'node_modules/package/SKILL.md',
    'node_modules/package/docs/SKILL.md',
  ])('strips dependency agent documentation %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    const findings = checkBundleEntries([entry], 'fixture.mcpb');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(entry);
  });
});
