/**
 * work-subdir skill — host integration guards.
 *
 * Travels with the .claude/skills/work-subdir skill and is copied to
 * src/work-subdir-cli.test.ts on apply. Goes red if any host-side reach-in of
 * the per-wiring work_subdir feature is deleted or drifts:
 *   - migration 020 (the work_subdir column)
 *   - the ncl wirings --work-subdir flag + F1 agent-shared guard
 *   - getWorkSubdirsForAgentGroup (union query the container.json materializer uses)
 *   - resolveSessionWorkSubdir (the container-runner spawn reach-in)
 *   - validateWorkSubdir (the shared validator both sides call)
 * The build/typecheck leg guards the container-side reach-ins' signatures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// wirings create's postCommit projects destinations into live session DBs — no
// sessions run here, so keep it from opening on-disk DB files.
vi.mock('./modules/agent-to-agent/write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

import { validateWorkSubdir } from './work-subdir.js';
import { resolveSessionWorkSubdir } from './container-runner.js';
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  getMessagingGroupAgent,
  getWorkSubdirsForAgentGroup,
} from './db/index.js';
import { getDb } from './db/connection.js';
import { lookup } from './cli/registry.js';
import type { Session } from './types.js';
// Side-effect import: registers wirings-create / wirings-update.
import './cli/resources/wirings.js';

const now = () => new Date().toISOString();
const hostCtx = { caller: 'host' as const };

async function create(args: Record<string, unknown>) {
  return (await lookup('wirings-create')!.handler(args, hostCtx)) as Record<string, unknown>;
}
async function update(args: Record<string, unknown>) {
  return (await lookup('wirings-update')!.handler(args, hostCtx)) as Record<string, unknown>;
}

function mg(id: string) {
  createMessagingGroup({
    id,
    channel_type: 'test',
    platform_id: `pid-${id}`,
    instance: 'test',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  mg('mg-1');
  mg('mg-2');
});

afterEach(() => {
  closeDb();
});

describe('validateWorkSubdir', () => {
  it('accepts and normalizes a relative subdir', () => {
    expect(validateWorkSubdir('./projects//alpha/')).toBe('projects/alpha');
  });
  it('rejects absolute, empty, root, and .. escapes', () => {
    expect(() => validateWorkSubdir('/etc')).toThrow(/relative/);
    expect(() => validateWorkSubdir('')).toThrow(/empty/);
    expect(() => validateWorkSubdir('.')).toThrow(/subdirectory/);
    expect(() => validateWorkSubdir('a/../../etc')).toThrow(/\.\./);
  });
});

describe('migration 020 — work_subdir column', () => {
  it('is a nullable, default-free TEXT column', () => {
    const col = getDb()
      .prepare(`SELECT type, "notnull", dflt_value FROM pragma_table_info('messaging_group_agents') WHERE name = 'work_subdir'`)
      .get() as { type: string; notnull: number; dflt_value: unknown } | undefined;
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });
});

describe('ncl wirings --work-subdir', () => {
  it('stores a normalized relative subdir on create', async () => {
    const row = await create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1', work_subdir: './projects//alpha/' });
    expect(getMessagingGroupAgent(row.id as string)!.work_subdir).toBe('projects/alpha');
  });
  it('rejects absolute / .. on create', async () => {
    await expect(create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1', work_subdir: '/etc' })).rejects.toThrow(/relative/);
    await expect(create({ messaging_group_id: 'mg-2', agent_group_id: 'ag-1', work_subdir: '../x' })).rejects.toThrow(/\.\./);
  });
  it('F1: rejects --work-subdir with session_mode=agent-shared on create', async () => {
    await expect(
      create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1', session_mode: 'agent-shared', work_subdir: 'p/a' }),
    ).rejects.toThrow(/agent-shared/);
  });
  it('update sets, clears, and F1-guards both directions', async () => {
    const row = await create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1' });
    await update({ id: row.id, work_subdir: 'work/dir' });
    expect(getMessagingGroupAgent(row.id as string)!.work_subdir).toBe('work/dir');
    await expect(update({ id: row.id, session_mode: 'agent-shared' })).rejects.toThrow(/agent-shared/);
    await update({ id: row.id, work_subdir: '' });
    expect(getMessagingGroupAgent(row.id as string)!.work_subdir ?? null).toBeNull();
  });
});

describe('getWorkSubdirsForAgentGroup', () => {
  it('returns distinct, sorted, non-empty subdirs for the group', async () => {
    await create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1', work_subdir: 'projects/beta' });
    await create({ messaging_group_id: 'mg-2', agent_group_id: 'ag-1', work_subdir: 'projects/alpha' });
    expect(getWorkSubdirsForAgentGroup('ag-1')).toEqual(['projects/alpha', 'projects/beta']);
  });
  it('returns empty when no wiring sets a subdir', async () => {
    await create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1' });
    expect(getWorkSubdirsForAgentGroup('ag-1')).toEqual([]);
  });
});

describe('resolveSessionWorkSubdir (container-runner spawn reach-in)', () => {
  function session(messagingGroupId: string | null): Session {
    return {
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: messagingGroupId,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
  }

  it('resolves the wiring subdir for a session', async () => {
    await create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1', work_subdir: 'projects/alpha' });
    expect(resolveSessionWorkSubdir(session('mg-1'))).toBe('projects/alpha');
  });
  it('returns null for a task/system session (no messaging group)', () => {
    expect(resolveSessionWorkSubdir(session(null))).toBeNull();
  });
  it('returns null when the wiring sets no subdir', async () => {
    await create({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1' });
    expect(resolveSessionWorkSubdir(session('mg-1'))).toBeNull();
  });
});
