/**
 * `ncl sessions close` — the skill-owned retirement operation.
 *
 * Ships with the `work-subdir` skill because that is the feature that needs it:
 * `work_subdir` is resolved from the wiring at every container spawn and never
 * stored on the session, so a container that was already running when the
 * wiring changed keeps its stale `NANOCLAW_WORK_SUBDIR`. Retiring the session
 * makes the next message build a fresh one against the current wiring.
 *
 * Kept out of `src/cli/resources/sessions.ts` on purpose: the reach-in there is
 * two lines (an import and `customOperations: { close: closeSessionOperation }`),
 * so REMOVE.md can reverse it exactly and a reapply can never duplicate it.
 *
 * Why `close` and not `delete`: `pending_questions.session_id` (NOT NULL) and
 * `pending_approvals.session_id` both carry an FK to `sessions(id)` and the
 * connection runs `foreign_keys = ON`, so a single-table DELETE fails the moment
 * a card is outstanding. `status = 'closed'` is already in the column's enum,
 * every session lookup filters `status = 'active'`, and `host-sweep.ts` uses
 * exactly this transition to GC spent task sessions.
 */
import type { CustomOperation } from './cli/crud.js';
import { isContainerRunning, killContainer } from './container-runner.js';
import { countDueMessages, getDeliveredIds, getDueOutboundMessages } from './db/session-db.js';
import { getSession, updateSession } from './db/sessions.js';
import { log } from './log.js';
import { openOutboundDb, withInboundDb } from './session-manager.js';

/**
 * Count the work a close would abandon, so the operator is told the cost
 * before it becomes a silent loss:
 *   - `pending_in`  — inbound rows still due; a closed session is no longer
 *     swept (host-sweep walks active sessions only) so these never run.
 *   - `undelivered_out` — outbound rows the delivery poll hasn't shipped yet;
 *     a closed + stopped session is drained by neither poll loop
 *     (pollActive filters container_status, pollSweep filters status).
 *
 * Read-only and best-effort: a session whose folder was `rm -rf`'d by an
 * operator still closes cleanly, it just reports zeros.
 */
function countAbandonedWork(
  agentGroupId: string,
  sessionId: string,
): {
  pending_in: number;
  undelivered_out: number;
} {
  try {
    return withInboundDb(agentGroupId, sessionId, (inDb) => {
      const pending_in = countDueMessages(inDb);
      let undelivered_out = 0;
      try {
        const outDb = openOutboundDb(agentGroupId, sessionId);
        try {
          const delivered = getDeliveredIds(inDb);
          undelivered_out = getDueOutboundMessages(outDb).filter((m) => !delivered.has(m.id)).length;
        } finally {
          outDb.close();
        }
      } catch {
        // outbound.db absent (container never started) — nothing to strand.
      }
      return { pending_in, undelivered_out };
    });
  } catch {
    return { pending_in: 0, undelivered_out: 0 };
  }
}

export type CloseResult = {
  closed: string;
  already_closed: boolean;
  container_killed: boolean;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  abandoned: { pending_in: number; undelivered_out: number };
};

export const closeSessionOperation: CustomOperation = {
  access: 'approval',
  description:
    'Retire a session: stop its container and set status=closed so no message ever routes to it again. ' +
    'The next message on the same (agent group, chat, thread) creates a FRESH session, which re-resolves ' +
    'the current wiring at spawn — use this to make a wiring change that is baked into a running container ' +
    '(work_subdir / container cwd, provider, mounts) take effect on a clean session instead of an existing one. ' +
    'Idempotent: closing an already-closed session succeeds and only re-checks the container. ' +
    'Preserves everything else — the sessions row, its inbound.db / outbound.db, the messaging group, the ' +
    'wiring, and the group-level conversation transcripts under groups/<folder>/conversations/. ' +
    'Consequence: due-but-unprocessed inbound messages are abandoned (a closed session is no longer swept) ' +
    'and any outbound reply not yet delivered is stranded — both counts are reported. ' +
    'To restart in place and keep the session, use `ncl groups restart` instead.',
  args: [{ name: 'id', type: 'string', description: 'Session ID to close.', required: true }],
  examples: [
    'ncl sessions close sess-1785250879340-g93ylp',
    'ncl sessions list --agent-group-id ag-123 --status active   # find the id first',
  ],
  handler: async (args): Promise<CloseResult> => {
    const id = args.id as string;
    const session = getSession(id);
    if (!session) throw new Error(`session not found: ${id}`);

    const alreadyClosed = session.status === 'closed';
    const abandoned = alreadyClosed
      ? { pending_in: 0, undelivered_out: 0 }
      : countAbandonedWork(session.agent_group_id, id);

    // Kill before flipping status: the container is what keeps producing
    // output nothing will drain once the session leaves both poll loops.
    // Also covers the idempotent path — an already-closed row with a live
    // container is exactly the state a half-finished close leaves behind.
    const containerKilled = isContainerRunning(id);
    if (containerKilled) killContainer(id, 'closed via `ncl sessions close`');

    // container_status too: the row must not linger as 'running', or
    // pollActive keeps draining a session the operator retired.
    updateSession(id, { status: 'closed', container_status: 'stopped' });

    log.info('Session closed via ncl', {
      sessionId: id,
      agentGroupId: session.agent_group_id,
      alreadyClosed,
      containerKilled,
      abandoned,
    });

    return {
      closed: id,
      already_closed: alreadyClosed,
      container_killed: containerKilled,
      agent_group_id: session.agent_group_id,
      messaging_group_id: session.messaging_group_id,
      thread_id: session.thread_id,
      abandoned,
    };
  },
  formatHuman: (data) => {
    const d = data as CloseResult;
    const lines = [
      d.already_closed ? `Session ${d.closed} was already closed.` : `Closed session ${d.closed}.`,
      `  agent group:     ${d.agent_group_id}`,
      `  messaging group: ${d.messaging_group_id ?? '(none — agent-shared or task session)'}`,
      `  thread:          ${d.thread_id ?? '(none)'}`,
      `  container:       ${d.container_killed ? 'killed' : 'was not running'}`,
    ];
    if (d.abandoned.pending_in > 0 || d.abandoned.undelivered_out > 0) {
      lines.push(
        `  abandoned:       ${d.abandoned.pending_in} pending inbound, ${d.abandoned.undelivered_out} undelivered outbound`,
      );
    }
    lines.push('The next message in this chat/thread starts a fresh session from the current wiring.');
    return lines.join('\n');
  },
};
