# Remove telegram-topic-support

Reverses every change `SKILL.md` apply made. After removing, task/system
sessions fall back to the upstream behaviour (null routing → base chat).

1. **Delete the skill-owned files:**
   ```bash
   rm -f src/task-origin-routing.ts src/telegram-topic-support.test.ts src/telegram-topic-defaults.test.ts
   ```

2. **Revert `src/session-manager.ts`:**
   - Delete the import `import { resolveTaskThreadRouting } from './task-origin-routing.js';`
   - In `writeSessionRouting`, delete the `else { ... resolveTaskThreadRouting ... }`
     branch, remove the `let threadId` local, and write `thread_id: session.thread_id`
     again in the `upsertSessionRouting` call. The block returns to:
     ```ts
     let channelType: string | null = null;
     let platformId: string | null = null;
     if (session.messaging_group_id) {
       const mg = getMessagingGroup(session.messaging_group_id);
       if (mg) {
         channelType = mg.channel_type;
         platformId = mg.platform_id;
       }
     }
     ```

3. **Revert `container/agent-runner/src/poll-loop.ts`:**
   - Delete the import `import { getSessionRouting } from './db/session-routing.js';`
     (only if no other code in the file uses it).
   - Delete the `telegram-topic-support` fallback block before the final
     `return null;` in `resolveDestinationThread`.

4. **Revert `src/channels/telegram.ts`** (if Telegram installed):
   - Set `supportsThreads: false` back.
   - Set `TELEGRAM_DEFAULTS.group.threads` back to `false`.

5. **Rebuild:**
   ```bash
   pnpm run build
   pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
   ```
