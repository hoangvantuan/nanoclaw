/**
 * telegram-topic-support skill — skill-owned host code.
 *
 * Resolve routing for a task/system session back to the Telegram forum topic it
 * was created from. A task/system session owns no messaging group, so the core
 * default would write null routing and any *addressed* send from a task fire
 * would lose the origin topic — Telegram then drops it into "General". We read
 * `originSessionId` off the session's newest task row and map that origin
 * session → its messaging group + thread.
 *
 * The single reach-in lives in `src/session-manager.ts::writeSessionRouting`,
 * which calls `resolveTaskThreadRouting`. See the skill's SKILL.md.
 */
import { openInboundDb as openInboundDbRaw } from './db/session-db.js';
import { inboundDbPath } from './session-manager.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession, isTaskThread } from './db/sessions.js';

export interface TaskThreadRouting {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

/**
 * For a task/system session (thread id matches `isTaskThread`), resolve the
 * channel + thread of the session that created the task. Returns null for a
 * non-task thread, a task with no origin (CLI-created), or an origin session /
 * messaging group that no longer exists — the caller then keeps the core
 * default (null routing, internal task thread id), exactly as before.
 */
export function resolveTaskThreadRouting(
  agentGroupId: string,
  sessionId: string,
  threadId: string | null,
): TaskThreadRouting | null {
  if (!isTaskThread(threadId)) return null;

  const originSessionId = readOriginSessionId(agentGroupId, sessionId);
  if (!originSessionId) return null;

  const origin = getSession(originSessionId);
  if (!origin || !origin.messaging_group_id) return null;
  const mg = getMessagingGroup(origin.messaging_group_id);
  if (!mg) return null;
  return { channelType: mg.channel_type, platformId: mg.platform_id, threadId: origin.thread_id };
}

/**
 * Read `originSessionId` off the newest task row in the session's inbound.db
 * (every occurrence in a series carries the same value). Returns null when there
 * is no task row or the content is malformed / carries no origin.
 */
function readOriginSessionId(agentGroupId: string, sessionId: string): string | null {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  try {
    const row = db.prepare(`SELECT content FROM messages_in WHERE kind = 'task' ORDER BY rowid DESC LIMIT 1`).get() as
      | { content: string }
      | undefined;
    if (!row) return null;
    try {
      return (JSON.parse(row.content) as { originSessionId?: string | null }).originSessionId ?? null;
    } catch {
      // Malformed content — treat as no origin.
      return null;
    }
  } finally {
    db.close();
  }
}
