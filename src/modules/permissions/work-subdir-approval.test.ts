/**
 * Integration guard for the work-subfolder question in unknown-channel
 * approval. This file travels with the work-subdir skill and drives the real
 * response-handler + router-interceptor seams; only delivery and container
 * spawn are external boundaries.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { grantRole } from './db/user-roles.js';
import { upsertUser } from './db/users.js';

const TEST_DIR = '/tmp/nanoclaw-test-work-subdir-approval';
const CHANNEL = 'work-subdir-approval-test';

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter(CHANNEL, { factory: () => null, defaults: channelDefaults });

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('platform-message-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-work-subdir-approval',
    GROUPS_DIR: '/tmp/nanoclaw-test-work-subdir-approval/groups',
  };
});

function now(): string {
  return new Date().toISOString();
}

function groupMention(platformId: string) {
  return {
    channelType: CHANNEL,
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

function ownerReply(text: string) {
  return {
    channelType: CHANNEL,
    platformId: 'dm-owner',
    threadId: null,
    message: {
      id: `reply-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text }),
      timestamp: now(),
    },
  };
}

async function clickConnect(messagingGroupId: string): Promise<void> {
  const { getResponseHandlers } = await import('../../response-registry.js');
  for (const handler of getResponseHandlers()) {
    const claimed = await handler({
      questionId: messagingGroupId,
      value: 'connect:ag-1',
      userId: 'owner',
      channelType: CHANNEL,
      platformId: 'dm-owner',
      threadId: null,
    });
    if (claimed) return;
  }
  throw new Error('No response handler claimed the channel approval');
}

async function clickNewAgent(messagingGroupId: string): Promise<void> {
  const { getResponseHandlers } = await import('../../response-registry.js');
  for (const handler of getResponseHandlers()) {
    const claimed = await handler({
      questionId: messagingGroupId,
      value: 'new_agent',
      userId: 'owner',
      channelType: CHANNEL,
      platformId: 'dm-owner',
      threadId: null,
    });
    if (claimed) return;
  }
  throw new Error('No response handler claimed the new-agent approval');
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  await import('./index.js');

  createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  upsertUser({ id: `${CHANNEL}:owner`, kind: CHANNEL, display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: `${CHANNEL}:owner`,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: CHANNEL,
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });

  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`${CHANNEL}:owner`, CHANNEL, 'mg-dm-owner', now());

  deliverMock.mockClear();
  const { wakeContainer } = await import('../../container-runner.js');
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('work-subfolder channel approval', () => {
  it('waits for a valid subfolder and persists it before the first container wake', async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');
    const { wakeContainer } = await import('../../container-runner.js');
    const observedAtWake: Array<string | null | undefined> = [];
    vi.mocked(wakeContainer).mockImplementation(async () => {
      const row = getDb().prepare('SELECT work_subdir FROM messaging_group_agents LIMIT 1').get() as
        | { work_subdir: string | null }
        | undefined;
      observedAtWake.push(row?.work_subdir);
      return true;
    });

    await routeInbound(groupMention('group-valid-subdir'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    await clickConnect(pending.messaging_group_id);

    const countBeforeReply = (
      getDb().prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get() as { count: number }
    ).count;
    expect(countBeforeReply).toBe(0);
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text).toContain('working subfolder');

    await routeInbound(ownerReply('./projects//sales/'));

    const wiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { work_subdir: string | null };
    expect(wiring.work_subdir).toBe('projects/sales');
    expect(observedAtWake).toEqual(['projects/sales']);
    expect(getDb().prepare('SELECT 1 FROM pending_channel_approvals').get()).toBeUndefined();
  });

  it("connects with the shared folder when the approver replies 'no'", async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(groupMention('group-shared-folder'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    await clickConnect(pending.messaging_group_id);
    await routeInbound(ownerReply('no'));

    const wiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { work_subdir: string | null };
    expect(wiring.work_subdir).toBeNull();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT 1 FROM pending_channel_approvals').get()).toBeUndefined();
  });

  it('keeps the first work-subfolder prompt armed when the same approver opens another', async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');

    await routeInbound(groupMention('group-first-prompt'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = getDb().prepare("SELECT id FROM messaging_groups WHERE platform_id = 'group-first-prompt'").get() as {
      id: string;
    };
    await clickConnect(first.id);

    await routeInbound(groupMention('group-second-prompt'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = getDb()
      .prepare("SELECT id FROM messaging_groups WHERE platform_id = 'group-second-prompt'")
      .get() as { id: string };
    await clickConnect(second.id);

    expect(JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text).toContain('Finish the pending');

    await routeInbound(ownerReply('projects/first'));

    const firstWiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(first.id) as { work_subdir: string };
    expect(firstWiring.work_subdir).toBe('projects/first');
    expect(
      getDb().prepare('SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ?').get(second.id),
    ).toBeUndefined();
    expect(
      getDb().prepare('SELECT 1 FROM pending_channel_approvals WHERE messaging_group_id = ?').get(second.id),
    ).toBeDefined();
  });

  it('discards a stale prompt before arming another approval for the same approver', async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');

    await routeInbound(groupMention('group-stale-prompt'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = getDb().prepare("SELECT id FROM messaging_groups WHERE platform_id = 'group-stale-prompt'").get() as {
      id: string;
    };
    await clickConnect(first.id);
    getDb().prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?').run(first.id);

    await routeInbound(groupMention('group-after-stale-prompt'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = getDb()
      .prepare("SELECT id FROM messaging_groups WHERE platform_id = 'group-after-stale-prompt'")
      .get() as { id: string };
    await clickConnect(second.id);

    expect(JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text).toContain('working subfolder');

    await routeInbound(ownerReply('projects/after-stale'));

    const wiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(second.id) as { work_subdir: string };
    expect(wiring.work_subdir).toBe('projects/after-stale');
  });

  it.each(['NO', 'skip', 'không', ''])('treats %j as a shared-folder choice', async (choice) => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');

    await routeInbound(groupMention(`group-shared-${choice || 'empty'}`));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    await clickConnect(pending.messaging_group_id);
    await routeInbound(ownerReply(choice));

    const wiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { work_subdir: string | null };
    expect(wiring.work_subdir).toBeNull();
  });

  it('keeps waiting after an invalid subfolder and accepts the next valid reply', async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(groupMention('group-invalid-subdir'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    await clickConnect(pending.messaging_group_id);

    await routeInbound(ownerReply('../escape'));

    expect(getDb().prepare('SELECT 1 FROM messaging_group_agents').get()).toBeUndefined();
    expect(getDb().prepare('SELECT 1 FROM pending_channel_approvals').get()).toBeDefined();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text).toContain('invalid');

    await routeInbound(ownerReply('projects/recovered'));

    const wiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { work_subdir: string | null };
    expect(wiring.work_subdir).toBe('projects/recovered');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed completion and keeps the reply capture armed for retry', async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(groupMention('group-completion-retry'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    await clickConnect(pending.messaging_group_id);

    getDb().exec(`
      CREATE TRIGGER fail_work_subdir_update
      BEFORE UPDATE OF work_subdir ON messaging_group_agents
      BEGIN
        SELECT RAISE(ABORT, 'forced work_subdir failure');
      END;
    `);

    await routeInbound(ownerReply('projects/first-attempt'));

    expect(getDb().prepare('SELECT 1 FROM messaging_group_agents').get()).toBeUndefined();
    expect(getDb().prepare('SELECT 1 FROM pending_channel_approvals').get()).toBeDefined();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text).toContain("couldn't be connected");

    getDb().exec('DROP TRIGGER fail_work_subdir_update');
    await routeInbound(ownerReply('projects/second-attempt'));

    const wiring = getDb()
      .prepare('SELECT work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { work_subdir: string | null };
    expect(wiring.work_subdir).toBe('projects/second-attempt');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('asks for the subfolder after naming a new agent and wires only after the answer', async () => {
    const { getDb } = await import('../../db/connection.js');
    const { routeInbound } = await import('../../router.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(groupMention('group-new-agent'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const initialCard = deliverMock.mock.calls
      .map((call) => JSON.parse(call[4] as string) as { type?: string; options?: Array<{ value: string }> })
      .find((payload) => payload.type === 'ask_question');
    expect(initialCard?.options?.map((option) => option.value)).toContain('choose_existing');
    const pending = getDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    await clickNewAgent(pending.messaging_group_id);
    await routeInbound(ownerReply('Bravo'));

    const created = getDb().prepare("SELECT id FROM agent_groups WHERE name = 'Bravo'").get() as { id: string };
    expect(created).toBeDefined();
    expect(getDb().prepare('SELECT 1 FROM messaging_group_agents').get()).toBeUndefined();
    expect(getDb().prepare('SELECT 1 FROM pending_channel_approvals').get()).toBeDefined();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text).toContain('working subfolder');

    await routeInbound(ownerReply('projects/bravo'));

    const wiring = getDb()
      .prepare('SELECT agent_group_id, work_subdir FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { agent_group_id: string; work_subdir: string | null };
    expect(wiring).toEqual({ agent_group_id: created.id, work_subdir: 'projects/bravo' });
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });
});
