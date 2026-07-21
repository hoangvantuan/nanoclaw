/**
 * work-subdir skill — container-side Codex trust guard.
 *
 * Travels with the .claude/skills/work-subdir skill and is copied to
 * container/agent-runner/src/providers/work-subdir-codex.test.ts on apply.
 * Goes red if writeCodexConfigToml stops writing a trusted project block per
 * work subdir — the reach-in that makes project-scoped .codex/config.toml MCP
 * merge with the global config (Codex >= 0.144.5).
 */
import { describe, expect, it, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeCodexConfigToml } from './codex-app-server.js';

// writeCodexConfigToml now takes the memory session hook as its second arg
// (upstream memory feature); the trusted-projects opt moved to the third arg.
const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

let tmpHome: string | null = null;
const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  }
});

describe('writeCodexConfigToml — work_subdir trust block', () => {
  it('writes a trusted project block per subdir, deduped and sorted', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    writeCodexConfigToml({}, MEMORY_SESSION_HOOK, {
      trustedProjects: ['/workspace/agent/beta', '/workspace/agent/alpha', '/workspace/agent/beta'],
    });

    const content = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('[projects."/workspace/agent/alpha"]');
    expect(content).toContain('[projects."/workspace/agent/beta"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content.match(/trust_level = "trusted"/g)).toHaveLength(2);
    expect(content.indexOf('/workspace/agent/alpha')).toBeLessThan(content.indexOf('/workspace/agent/beta'));
  });

  it('omits the projects section when no trusted projects are given', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    writeCodexConfigToml({ nanoclaw: { command: 'bun', args: [] } }, MEMORY_SESSION_HOOK);

    const content = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).not.toContain('[projects.');
  });
});
