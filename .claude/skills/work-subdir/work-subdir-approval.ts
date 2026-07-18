/**
 * Pre-wire work-subfolder capture for unknown-channel approvals.
 *
 * The pending channel-approval row stays durable while this module keeps the
 * next-DM arming in memory. A restart loses only the arming: the original card
 * and pending row remain, so an existing target can be clicked again. A target
 * created just before restart must be selected through "Choose existing".
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import { validateWorkSubdir } from '../../work-subdir.js';
import { getPendingChannelApproval, type PendingChannelApproval } from './db/pending-channel-approvals.js';
import { ensureUserDm } from './user-dm.js';

const PROMPT_TEXT =
  'Use a separate working subfolder for this channel? Reply with a relative path ' +
  "(for example, projects/sales), or 'no' to use the shared folder.";
const SHARED_FOLDER_CHOICES = new Set(['', 'no', 'n', 'skip', 'shared', 'không', 'khong']);

export type CompleteWorkSubdirApproval = (
  row: PendingChannelApproval,
  agentGroupId: string,
  approverId: string,
  workSubdir: string | null,
) => Promise<boolean>;

interface WorkSubdirArming {
  messagingGroupId: string;
  agentGroupId: string;
  approverId: string;
  complete: CompleteWorkSubdirApproval;
  ready: boolean;
}

export interface PromptForWorkSubdirInput {
  row: PendingChannelApproval;
  agentGroupId: string;
  approverId: string;
  complete: CompleteWorkSubdirApproval;
}

const awaitingWorkSubdir = new Map<string, WorkSubdirArming>();

function dmKey(channelType: string, platformId: string): string {
  return `${channelType}:${platformId}`;
}

function extractText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

async function deliverText(channelType: string, platformId: string, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(channelType, platformId, null, 'chat-sdk', JSON.stringify({ text }));
  } catch (err) {
    log.error('Channel registration: work-subfolder message delivery failed', {
      channelType,
      platformId,
      err,
    });
  }
}

/** Prompt the approver and arm their next DM before any wiring is created. */
export async function promptForWorkSubdir(input: PromptForWorkSubdirInput): Promise<boolean> {
  const dm = await ensureUserDm(input.row.approver_user_id);
  const adapter = getDeliveryAdapter();
  if (!dm || !adapter) {
    log.error('Channel registration: cannot prompt for work subfolder', {
      messagingGroupId: input.row.messaging_group_id,
      hasDm: Boolean(dm),
      hasAdapter: Boolean(adapter),
    });
    return false;
  }

  const key = dmKey(dm.channel_type, dm.platform_id);
  const existing = awaitingWorkSubdir.get(key);
  if (existing && !getPendingChannelApproval(existing.messagingGroupId)) {
    awaitingWorkSubdir.delete(key);
    log.info('Channel registration: discarded stale work-subfolder prompt', {
      messagingGroupId: existing.messagingGroupId,
      approverUserId: input.row.approver_user_id,
    });
  }
  if (awaitingWorkSubdir.has(key)) {
    log.warn('Channel registration: approver already has a pending work-subfolder prompt', {
      messagingGroupId: input.row.messaging_group_id,
      approverUserId: input.row.approver_user_id,
    });
    await deliverText(
      dm.channel_type,
      dm.platform_id,
      'Finish the pending working-subfolder reply before opening another channel approval.',
    );
    return false;
  }

  const arming: WorkSubdirArming = {
    messagingGroupId: input.row.messaging_group_id,
    agentGroupId: input.agentGroupId,
    approverId: input.approverId,
    complete: input.complete,
    ready: false,
  };
  awaitingWorkSubdir.set(key, arming);

  try {
    await adapter.deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text: PROMPT_TEXT }));
  } catch (err) {
    log.error('Channel registration: work-subfolder prompt delivery failed', {
      messagingGroupId: input.row.messaging_group_id,
      err,
    });
    if (awaitingWorkSubdir.get(key) === arming) awaitingWorkSubdir.delete(key);
    return false;
  }

  arming.ready = true;
  return true;
}

/** Capture the armed approver DM, then create the wiring before replay. */
export async function captureWorkSubdirReply(event: InboundEvent): Promise<boolean> {
  const key = dmKey(event.channelType, event.platformId);
  const arming = awaitingWorkSubdir.get(key);
  if (!arming?.ready) return false;

  const row = getPendingChannelApproval(arming.messagingGroupId);
  if (!row) {
    awaitingWorkSubdir.delete(key);
    return false;
  }

  const raw = extractText(event).trim();
  let workSubdir: string | null;
  try {
    workSubdir = SHARED_FOLDER_CHOICES.has(raw.toLowerCase()) ? null : validateWorkSubdir(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await deliverText(
      event.channelType,
      event.platformId,
      `That working subfolder is invalid: ${detail}. Reply with another relative path, or 'no'.`,
    );
    return true;
  }
  let wired: boolean;
  try {
    wired = await arming.complete(row, arming.agentGroupId, arming.approverId, workSubdir);
  } catch (err) {
    log.error('Channel registration: work-subfolder completion failed', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    await deliverText(
      event.channelType,
      event.platformId,
      "The channel couldn't be connected. Reply with the working subfolder again to retry.",
    );
    return true;
  }

  awaitingWorkSubdir.delete(key);
  await deliverText(
    event.channelType,
    event.platformId,
    wired
      ? workSubdir
        ? `Connected. This channel now works in "${workSubdir}".`
        : 'Connected. This channel uses the shared working folder.'
      : "The channel couldn't be connected. Check the host logs and retry from the approval card.",
  );
  return true;
}

registerMessageInterceptor(captureWorkSubdirReply);
