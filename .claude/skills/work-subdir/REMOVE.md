# Remove per-wiring working subfolder (`work_subdir`)

Idempotent — safe to run even if some steps were never applied. Reverses every change apply made. (The migration already applied to a live DB leaves the nullable `work_subdir` column in place; that is harmless dead storage — dropping a column needs a SQLite table rebuild, so leave it unless you specifically need it gone.)

## 1. Delete the copied files

```bash
rm -f src/work-subdir.ts \
      src/db/migrations/020-wiring-work-subdir.ts \
      src/work-subdir-cli.test.ts \
      src/modules/permissions/work-subdir-approval.ts \
      src/modules/permissions/work-subdir-approval.test.ts \
      src/session-close.ts \
      src/session-close.test.ts \
      container/agent-runner/src/providers/work-subdir-codex.test.ts
```

## 2. Unregister migration 020

In `src/db/migrations/index.ts`: delete the `import { migration020 } from './020-wiring-work-subdir.js';` line and the `migration020,` entry from the `migrations` array.

## 3. Revert the DB layer

- `src/types.ts` — remove `work_subdir?: string | null;` from `MessagingGroupAgent`.
- `src/db/schema.ts` — remove the `work_subdir TEXT` reference line on `messaging_group_agents`.
- `src/db/messaging-groups.ts` — delete the `getWorkSubdirsForAgentGroup` and `setWiringWorkSubdir` functions.
- `src/db/index.ts` — remove `getWorkSubdirsForAgentGroup` and `setWiringWorkSubdir` from the `./messaging-groups.js` export block.

## 4. Revert `ncl wirings` (`src/cli/resources/wirings.ts`)

- Remove the `import { validateWorkSubdir } from '../../work-subdir.js';` import and the `WORK_SUBDIR_AGENT_SHARED_ERROR` const.
- Remove the `work_subdir` column from the `columns` array.
- Remove the `work_subdir` normalization + F1 block from `preUpdate`.
- Remove the `args.work_subdir` block from the custom `create` handler.
- Remove `--work-subdir` from the create verb's description.

## 4b. Revert the onboarding wiring reach-ins

- `setup/register.ts` — remove the `setWiringWorkSubdir` and `validateWorkSubdir` imports, the `workSubdir?` field on `RegisterArgs`, the `--work-subdir` parse case, the F1 check after the parse loop, the `setWiringWorkSubdir(mgaId, …)` call, and the `WORK_SUBDIR` status field.
- `.claude/skills/manage-channels/SKILL.md` — remove the "Work-subfolder Question" subsection and the `--work-subdir` entry from the register command's optional-overrides list.

## 4c. Revert the unknown-channel DM approval reach-ins

In `src/modules/permissions/index.ts`:

- Remove `setWiringWorkSubdir` from the `../../db/messaging-groups.js` import. Remove the `getDb` and `promptForWorkSubdir` imports.
- Remove the trailing `workSubdir: string | null = null` argument from `wireApprovedChannel` and delete `if (workSubdir) setWiringWorkSubdir(mgaId, workSubdir);`.
- Unwrap the `getDb().transaction(() => { ... })()` block: leave `createMessagingGroupAgent(...)`, sender admission, and `deletePendingChannelApproval(...)` as their original sequential statements before `routeInbound(event)`.
- Replace the `promptForWorkSubdir(...)` block in the `connect:<id>` response path with `await wireApprovedChannel(row, targetAgentGroupId, approverId);`.
- Replace the `promptForWorkSubdir(...)` block after a new agent is created with the original direct wiring and confirmation:

```ts
  const wired = await wireApprovedChannel(row, ag.id, userId);

  const adapter = getDeliveryAdapter();
  if (adapter) {
    const dm = await ensureUserDm(row.approver_user_id);
    if (dm) {
      adapter
        .deliver(
          dm.channel_type,
          dm.platform_id,
          null,
          'chat-sdk',
          JSON.stringify({
            text: wired
              ? `✅ Agent "${ag.name}" created and connected.`
              : `⚠️ Agent "${ag.name}" was created but the channel couldn't be connected — check the host logs.`,
          }),
        )
        .catch(() => {});
    }
  }
```

Restore the three adjacent comment blocks in `src/modules/permissions/index.ts`: `wireApprovedChannel` is shared by the two approve paths, `connect:<id>` wires and replays while `new_agent` captures and creates immediately, and the name interceptor creates, wires, and replays. These are comment replacements, not additions.

In `src/modules/permissions/channel-approval.ts`, restore `buildApprovalOptions` to add `CHOOSE_EXISTING_VALUE` only in the `else if (visibleAgentGroups.length > 1)` branch after the single-agent direct-connect branch. Restore the module header so connect and new-agent replies wire and replay immediately without mentioning a working-folder question.

In `src/modules/permissions/channel-approval.test.ts`, delete the `chooseSharedWorkFolder()` helper and its five calls. Restore the identical-wirings comment to `Owner replies with the agent name in their DM — interceptor wires.` The original tests then assert wiring immediately after the connect click or new-agent name reply.

## 5. Revert the host container-runner (`src/container-runner.ts`)

- Drop `execFileSync` from the `child_process` import; remove the `getMessagingGroupAgentByPair` and `validateWorkSubdir` imports.
- Delete the `resolveSessionWorkSubdir` and `provisionWorkSubdir` functions.
- Remove the `workSubdir` resolve/provision block in `spawnContainer` and the `workSubdir` argument passed to `buildContainerArgs`.
- Remove the trailing `workSubdir?: string | null` parameter from `buildContainerArgs` and the `NANOCLAW_WORK_SUBDIR` env push.

## 6. Revert host container-config (`src/container-config.ts`)

- Remove the `getWorkSubdirsForAgentGroup` import, the `workSubdirs?: string[];` field on `ContainerConfig`, and the `workSubdirs` materialize block in `materializeContainerJson`.

## 7. Revert the container agent-runner

- `container/agent-runner/src/config.ts` — remove `workSubdirs?: string[];` from `RunnerConfig` and its `loadConfig` line.
- `container/agent-runner/src/providers/types.ts` — remove `trustedWorkspaces?: string[];` from `ProviderOptions`.
- `container/agent-runner/src/index.ts` — restore `const CWD = '/workspace/agent'`; delete `resolveCwd`/`AGENT_ROOT`, the `trustedWorkspaces` computation, the `NANOCLAW_AGENT_CWD` MCP env, the `trustedWorkspaces` createProvider option, and pass `cwd: CWD` to `runPollLoop`.
- `container/agent-runner/src/mcp-tools/core.ts` — remove the `AGENT_CWD` const and restore `send_file`'s base to `path.resolve('/workspace/agent', filePath)`.
- `container/agent-runner/src/providers/codex-app-server.ts` — remove `trustedProjects` from `writeCodexConfigToml`'s opts and delete the trusted-project block loop.
- `container/agent-runner/src/providers/codex.ts` — remove the `trustedProjects` field and the `trustedProjects:` argument in the `writeCodexConfigToml(...)` call.

## 8. Revert `ncl sessions close`

- `src/cli/resources/sessions.ts` — remove the `import { closeSessionOperation } from '../../session-close.js';` line and the whole `customOperations: { close: closeSessionOperation },` entry together with its two-line comment. `operations: { list: 'open', get: 'open' },` is the original last property; leave it and the `delete`-rationale comment above it in place.
- `src/cli/dispatch.ts` — narrow the sessions pre-check back to `sessions-get` only and restore its original three-line comment:

```ts
      // Fail-closed pre-handler check for sessions-get: returns "not found"
      // regardless of whether the UUID exists in another group, preventing an
      // existence oracle across group boundaries.
      if (cmd.resource === 'sessions' && req.command === 'sessions-get' && req.args.id) {
```

- `CLAUDE.md` — restore the Admin CLI table's `sessions` row to `| sessions | list, get | Active sessions (read-only) |`.

Any session already set to `status='closed'` stays closed — that is a normal state the host produces on its own (host-sweep retires spent task sessions the same way), so there is nothing to undo in the DB.

## 9. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart "$(systemctl --user list-units --type=service --all --no-legend \
#          | grep -oE 'nanoclaw[^ ]*\.service' | head -1)"
```

If `better-sqlite3` fails to load, put the repo's pinned Node 22 first on `PATH`.

## Verification

`ncl wirings help` no longer lists `--work-subdir` and `ncl sessions help` no longer lists `close`; `pnpm run build` and `cd container/agent-runner && bun run typecheck` are clean; no `work-subdir` or `session-close` source or test files remain in `src/` or `container/agent-runner/src/`.
