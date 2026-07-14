---
name: telegram-topic-support
description: "Preserve Telegram forum topic threads for task/system sessions so scheduled tasks report back into the same channel + topic instead of collapsing to \"General\". Use when re-applying this customization to a fresh NanoClaw checkout, after `git reset --hard upstream/main`, or after `/update-nanoclaw`/`/update-skills` restores upstream files. Triggers: \"telegram topic\", \"forum topic\", \"tasks land in General\", \"re-apply telegram topic support\"."
---

# Telegram forum topic support for task sessions

Two behaviours combined:

1. **Enable threads on the Telegram adapter.** Chat SDK `@chat-adapter/telegram >= 4.29`
   encodes `message_thread_id` into `thread.id` and re-emits it on send, so a
   forum topic *is* a real thread. Flip the adapter capability so the router can
   preserve a topic's thread id. Non-forum groups and DMs inherit the
   `threads:false` per-wiring default and collapse to the base chat exactly as
   before.

2. **Route task/system sessions back to their origin topic.** A task/system
   session owns no messaging group, so core writes null routing and any
   *addressed* send from a task fire loses the origin topic — Telegram then drops
   it into "General". This skill reads `originSessionId` off the task row and
   recovers the origin session's channel + thread, on both the host (session
   routing producer) and the container (destination resolver / consumer).

**Depends on `/add-telegram`** — reach-in #3 edits the Telegram adapter file,
which only exists once Telegram is installed. Apply `/add-telegram` first, then
this skill. Reach-ins #1 and #2 are channel-agnostic and apply regardless.

## When to use

- After `git reset --hard upstream/main` (or any reset to a clean upstream) to
  re-apply this fork's customization.
- After `/update-nanoclaw` / `/update-skills` overwrites `session-manager.ts`,
  `poll-loop.ts`, or the Telegram adapter with upstream copies.
- On a **different NanoClaw checkout** that wants the same behaviour.

## Apply

Safe to re-run — every step checks for its own marker before editing.

### 1. Copy the skill-owned host source

```bash
cp .claude/skills/telegram-topic-support/src/task-origin-routing.ts src/task-origin-routing.ts
cp .claude/skills/telegram-topic-support/src/telegram-topic-support.test.ts src/telegram-topic-support.test.ts
```

### 2. Reach-in — host session routing producer (`src/session-manager.ts`)

In `writeSessionRouting`, the `if (session.messaging_group_id) { ... }` block
that sets `channelType` / `platformId` decides routing. Add an `else` branch that
delegates to the skill's `resolveTaskThreadRouting`. Also declare a mutable
`threadId` (default `session.thread_id`) and write it instead of `session.thread_id`.

- Add the import near the other local imports:
  ```ts
  import { resolveTaskThreadRouting } from './task-origin-routing.js';
  ```
- Change the routing setup so it reads (only add the `else` branch + the
  `threadId` local if not already present):
  ```ts
  let channelType: string | null = null;
  let platformId: string | null = null;
  let threadId: string | null = session.thread_id;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  } else {
    // telegram-topic-support skill: recover the origin topic for a task/system
    // session so scheduled tasks report back into the channel + thread they were
    // created from instead of collapsing to Telegram "General".
    const taskRouting = resolveTaskThreadRouting(agentGroupId, sessionId, session.thread_id);
    if (taskRouting) {
      channelType = taskRouting.channelType;
      platformId = taskRouting.platformId;
      threadId = taskRouting.threadId;
    }
  }
  ```
- In the `upsertSessionRouting({...})` call, write `thread_id: threadId` (not
  `thread_id: session.thread_id`).

> The logic itself lives in `src/task-origin-routing.ts`; the core edit is one
> import + one call. Do **not** re-add an inline `resolveTaskOriginRouting`
> helper or an `isTaskThread` import in `session-manager.ts` — both moved into
> the skill file.

### 3. Reach-in — container destination resolver (`container/agent-runner/src/poll-loop.ts`)

In `resolveDestinationThread`, just before the final `return null;`, add a
fallback to the session's default routing (which the host now stamps with the
task's origin topic):

- Add the import near the top:
  ```ts
  import { getSessionRouting } from './db/session-routing.js';
  ```
- Insert before the closing `return null;` of `resolveDestinationThread`:
  ```ts
  // telegram-topic-support: no matching inbound row (e.g. a task/system session,
  // which never received a real message from this channel). Fall back to the
  // session's default routing — the host stamps it with the task's origin topic —
  // but only when it points at this same channel+platform, so we never stamp one
  // channel's thread onto another.
  try {
    const sr = getSessionRouting();
    if (sr.channel_type === channelType && sr.platform_id === platformId && sr.thread_id) {
      return { threadId: sr.thread_id, inReplyTo: null };
    }
  } catch {
    // session_routing may be absent on older session DBs — ignore.
  }
  ```

### 4. Reach-in — Telegram adapter capability (`src/channels/telegram.ts`)

Only if Telegram is installed. In the `registerChannelAdapter('telegram', { ... })`
call, set `supportsThreads: true` (upstream ships `false`):

```ts
supportsThreads: true,
```

### 5. Build + verify

```bash
pnpm run build
pnpm test -- telegram-topic-support
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

`pnpm test -- telegram-topic-support` drives the real `writeSessionRouting` and
goes red if reach-in #2 is deleted or drifts. The container typecheck guards
reach-in #3 against drift (moved imports / renamed fields).

## Recipe

Order: `/add-telegram` → `telegram-topic-support`. Re-run this skill after every
upstream update that touches `session-manager.ts`, `poll-loop.ts`, or the
Telegram adapter.

## Troubleshooting

- **Tasks still land in "General".** Confirm reach-in #4 (`supportsThreads: true`)
  survived — `/update-skills` re-copies the Telegram adapter from the `channels`
  branch and reverts it. Re-run this skill.
- **`resolveTaskThreadRouting` import fails to resolve.** Step 1 wasn't run; copy
  `src/task-origin-routing.ts` in.
- **Task session has no origin (CLI-created task).** Expected — routing stays
  null and the send collapses to the base chat, exactly as upstream. Only tasks
  created from within a topic session carry `originSessionId`.
