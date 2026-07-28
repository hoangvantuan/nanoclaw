/**
 * `ncl sessions close` + the work_subdir re-resolution it exists to enable.
 *
 * Two things are pinned here:
 *
 *   1. close semantics — existence check, idempotence, container kill,
 *      `status`/`container_status` transition, and that nothing else is
 *      touched (the sessions row, the messaging group, the wiring, sibling
 *      sessions, and the FK-bearing pending_questions / pending_approvals rows
 *      all survive; a hard DELETE could not have left them intact).
 *
 *   2. the regression this was built for — `work_subdir` is NOT stored on the
 *      session, it is resolved from the wiring at spawn
 *      (`resolveSessionWorkSubdir`). A container that was already running when
 *      the wiring changed keeps its stale NANOCLAW_WORK_SUBDIR, so the fix is
 *      to retire the session and let the next message build a fresh one. The
 *      test walks that exact sequence: wiring points at A → session runs →
 *      wiring moves to B → close → next resolve creates a NEW session → that
 *      session resolves B.
 *
 * container-runner is partially mocked: `killContainer` / `isContainerRunning`
 * are stubbed (no Docker here) while `resolveSessionWorkSubdir` stays real —
 * it is the reach-in under test.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-cli-sessions';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-sessions' };
});

// vi.hoisted: the mock factories below are lifted above these declarations, so
// the stubs have to be created in the hoisted scope to be referenceable there.
const { killContainer, isContainerRunning } = vi.hoisted(() => ({
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>('./container-runner.js');
  return { ...actual, killContainer, isContainerRunning, wakeContainer: vi.fn().mockResolvedValue(true) };
});

// wirings create's postCommit projects destinations into live session DBs.
vi.mock('./modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: vi.fn() }));

import { resolveSessionWorkSubdir } from './container-runner.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getDb,
  initTestDb,
  runMigrations,
  setWiringWorkSubdir,
} from './db/index.js';
import { createSession, getSession } from './db/sessions.js';
import { resolveSession } from './session-manager.js';
import { dispatch } from './cli/dispatch.js';
import { lookup } from './cli/registry.js';
// Side-effect imports: register the sessions-* and wirings-* commands.
import './cli/resources/sessions.js';
import './cli/resources/wirings.js';

const GID = 'ag-close-test';
const MGID = 'mg-close-test';

const now = () => new Date().toISOString();
const hostCtx = { caller: 'host' as const };

function seedSession(id: string, overrides: Partial<Parameters<typeof createSession>[0]> = {}): void {
  createSession({
    id,
    agent_group_id: GID,
    messaging_group_id: MGID,
    thread_id: 'telegram:-100:general',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
    ...overrides,
  });
}

async function close(id: string) {
  return dispatch({ id: 'req-close', command: 'sessions-close', args: { id } }, hostCtx);
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  killContainer.mockClear();
  isContainerRunning.mockClear().mockReturnValue(false);

  runMigrations(initTestDb());
  createAgentGroup({ id: GID, name: 'Closer', folder: 'closer', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: MGID,
    channel_type: 'telegram',
    platform_id: 'telegram:-100',
    instance: 'telegram',
    name: 'general',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('ncl sessions close', () => {
  it('closes an active session, kills its container, and marks the container stopped', async () => {
    seedSession('sess-a');
    isContainerRunning.mockReturnValue(true);

    const resp = await close('sess-a');

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ closed: 'sess-a', already_closed: false, container_killed: true });

    expect(killContainer).toHaveBeenCalledWith('sess-a', expect.stringContaining('sessions close'));

    const row = getSession('sess-a')!;
    expect(row.status).toBe('closed');
    expect(row.container_status).toBe('stopped');
  });

  it('does not call killContainer when no container is running', async () => {
    seedSession('sess-b', { container_status: 'stopped' });

    const resp = await close('sess-b');

    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { container_killed: boolean } }).data.container_killed).toBe(false);
    expect(killContainer).not.toHaveBeenCalled();
    expect(getSession('sess-b')!.status).toBe('closed');
  });

  it('is idempotent — a second close succeeds and flags already_closed', async () => {
    seedSession('sess-c');
    await close('sess-c');

    const again = await close('sess-c');

    expect(again.ok).toBe(true);
    expect((again as { ok: true; data: { already_closed: boolean } }).data.already_closed).toBe(true);
    expect(getSession('sess-c')!.status).toBe('closed');
  });

  it('still kills a live container on the idempotent path (half-finished close)', async () => {
    seedSession('sess-c2', { status: 'closed' });
    isContainerRunning.mockReturnValue(true);

    await close('sess-c2');

    expect(killContainer).toHaveBeenCalledWith('sess-c2', expect.stringContaining('sessions close'));
    expect(getSession('sess-c2')!.container_status).toBe('stopped');
  });

  it('errors on an unknown session id', async () => {
    const resp = await close('sess-nope');

    expect(resp.ok).toBe(false);
    const error = (resp as { ok: false; error: { code: string; message: string } }).error;
    expect(error.code).toBe('handler-error');
    expect(error.message).toMatch(/not found/i);
  });

  it('requires --id', async () => {
    const resp = await dispatch({ id: 'req-noid', command: 'sessions-close', args: {} }, hostCtx);

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string } }).error.code).toBe('invalid-args');
  });

  it('preserves the session row, the messaging group, the wiring, and FK-bearing rows', async () => {
    seedSession('sess-d');
    const db = getDb();
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, session_mode, priority, created_at)
       VALUES ('mga-keep', ?, ?, 'mention', 'shared', 0, ?)`,
    ).run(MGID, GID, now());
    // Rows a hard DELETE FROM sessions could not have left behind: both carry
    // an FK to sessions(id) and the connection runs foreign_keys = ON.
    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES ('q-keep', 'sess-d', 'mout-1', 'q', '[]', ?)`,
    ).run(now());
    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES ('pa-keep', 'sess-d', 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run(now(), GID);

    expect((await close('sess-d')).ok).toBe(true);

    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE id = ?', 'sess-d')).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE id = ?', 'mga-keep')).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE question_id = ?', 'q-keep')).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM pending_approvals WHERE approval_id = ?', 'pa-keep')).toBe(1);
  });

  it('leaves sibling sessions of the same messaging group untouched', async () => {
    seedSession('sess-general');
    seedSession('sess-topic-18', { thread_id: 'telegram:-100:18' });

    await close('sess-general');

    expect(getSession('sess-general')!.status).toBe('closed');
    const sibling = getSession('sess-topic-18')!;
    expect(sibling.status).toBe('active');
    expect(sibling.container_status).toBe('running');
  });

  it('reports the work a close abandons', async () => {
    seedSession('sess-e', { container_status: 'stopped' });
    // Give the session real DBs, then queue an inbound row that is due but
    // unprocessed — a closed session is no longer swept, so it never runs.
    const { initSessionFolder, writeSessionMessage } = await import('./session-manager.js');
    initSessionFolder(GID, 'sess-e');
    writeSessionMessage(GID, 'sess-e', {
      id: 'm-1',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi', sender: 'x', senderId: 'telegram:1' }),
    });

    const resp = await close('sess-e');

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { abandoned: { pending_in: number } } }).data;
    expect(data.abandoned.pending_in).toBe(1);
    expect((resp as { ok: true; human: string }).human).toMatch(/1 pending inbound/);
  });

  it('is registered as approval-gated, so an agent caller holds for admin approval', () => {
    expect(lookup('sessions-close')!.access).toBe('approval');
  });

  it('resolves a dashed session id passed positionally', async () => {
    seedSession('sess-1785250879340-g93ylp');

    // What the client sends for `ncl sessions close sess-1785250879340-g93ylp`:
    // positional args joined with dashes onto the command name.
    const resp = await dispatch(
      { id: 'req-pos', command: 'sessions-close-sess-1785250879340-g93ylp', args: {} },
      hostCtx,
    );

    expect(resp.ok).toBe(true);
    expect(getSession('sess-1785250879340-g93ylp')!.status).toBe('closed');
  });
});

describe('a session created after a wiring work_subdir change runs in the new subdir', () => {
  it('closing the stale session makes the next resolve produce a fresh one bound to the new subdir', async () => {
    // Wiring initially points the container cwd at `kinh-dich`.
    const wiring = (await lookup('wirings-create')!.handler(
      { messaging_group_id: MGID, agent_group_id: GID, session_mode: 'shared', work_subdir: 'kinh-dich' },
      hostCtx,
    )) as { id: string };

    // The session that ran under the old wiring.
    const first = resolveSession(GID, MGID, 'telegram:-100:general', 'per-thread');
    expect(first.created).toBe(true);
    expect(resolveSessionWorkSubdir(first.session)).toBe('kinh-dich');

    // Operator fixes the wiring. The running container keeps its baked-in
    // NANOCLAW_WORK_SUBDIR — the DB change alone does not move it.
    setWiringWorkSubdir(wiring.id, 'wisdom-mentor');

    // Retire the stale session.
    isContainerRunning.mockReturnValue(true);
    expect((await close(first.session.id)).ok).toBe(true);
    expect(killContainer).toHaveBeenCalledWith(first.session.id, expect.stringContaining('sessions close'));

    // The next message on the same chat + thread must NOT reuse the closed
    // session (every lookup filters status='active') and the fresh one must
    // resolve the current wiring.
    const second = resolveSession(GID, MGID, 'telegram:-100:general', 'per-thread');
    expect(second.created).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.status).toBe('active');
    expect(resolveSessionWorkSubdir(second.session)).toBe('wisdom-mentor');

    // The retired session is still on record — closed, not deleted.
    expect(getSession(first.session.id)!.status).toBe('closed');
  });

  it('without a close, the same wiring change would have been picked up by the SAME session on next spawn', async () => {
    // The complement of the test above, and why `close` is a convenience for a
    // live container rather than a correctness requirement: work_subdir is
    // resolved from the wiring at every spawn, never stored on the session.
    const wiring = (await lookup('wirings-create')!.handler(
      { messaging_group_id: MGID, agent_group_id: GID, session_mode: 'shared', work_subdir: 'kinh-dich' },
      hostCtx,
    )) as { id: string };
    const { session } = resolveSession(GID, MGID, null, 'shared');

    setWiringWorkSubdir(wiring.id, 'wisdom-mentor');

    expect(resolveSessionWorkSubdir(session)).toBe('wisdom-mentor');
  });
});
