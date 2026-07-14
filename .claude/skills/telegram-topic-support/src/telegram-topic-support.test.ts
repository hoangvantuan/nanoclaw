/**
 * telegram-topic-support skill — integration test.
 *
 * Drives the REAL `writeSessionRouting` entry point (not the skill function
 * directly) so it goes red if the reach-in in session-manager.ts is deleted or
 * drifts. Copied into `src/` on apply; removed on REMOVE.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, resolveTaskSession, writeSessionRouting, inboundDbPath } from './session-manager.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-topic';
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-topic' };
});

function now() {
  return new Date().toISOString();
}

function readRouting(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
  };
  db.close();
  return row;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('telegram-topic-support: task session routing', () => {
  it('inherits the origin topic routing for a task session', () => {
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:-100999',
      name: 'Forum',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // The session the task was created from — a specific Telegram topic.
    const { session: origin } = resolveSession('ag-1', 'mg-1', 'telegram:-100999:46', 'per-thread');

    // Isolated task/system session + a task row carrying originSessionId.
    const { session: taskSession } = resolveTaskSession('ag-1', 'series-abc');
    const tdb = new Database(inboundDbPath('ag-1', taskSession.id));
    tdb.prepare('INSERT INTO messages_in (id, kind, timestamp, content) VALUES (?, ?, ?, ?)').run(
      'task-1',
      'task',
      now(),
      JSON.stringify({ prompt: 'daily', script: null, originSessionId: origin.id }),
    );
    tdb.close();

    writeSessionRouting('ag-1', taskSession.id);

    const row = readRouting('ag-1', taskSession.id);
    expect(row.channel_type).toBe('telegram');
    expect(row.platform_id).toBe('telegram:-100999');
    expect(row.thread_id).toBe('telegram:-100999:46');
  });

  it('writes null routing for a task session with no origin (CLI-created)', () => {
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

    const { session: taskSession } = resolveTaskSession('ag-1', 'series-cli');
    const tdb = new Database(inboundDbPath('ag-1', taskSession.id));
    tdb.prepare('INSERT INTO messages_in (id, kind, timestamp, content) VALUES (?, ?, ?, ?)').run(
      'task-1',
      'task',
      now(),
      JSON.stringify({ prompt: 'daily', script: null, originSessionId: null }),
    );
    tdb.close();

    writeSessionRouting('ag-1', taskSession.id);

    const row = readRouting('ag-1', taskSession.id);
    expect(row.channel_type).toBeNull();
    expect(row.platform_id).toBeNull();
    // Falls back to the internal task thread id, exactly as before.
    expect(row.thread_id).toBe('system:tasks:series-cli');
  });
});
