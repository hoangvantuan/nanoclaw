---
name: work-subdir
description: "Per-wiring working subfolder for NanoClaw. Give one channel/group its own isolated working directory (own files, git repo, project-scoped Codex MCP/skills) under the agent group dir, while still inheriting the group's global MCP/skill config. Install/reapply this skill to add the `--work-subdir` flag on `ncl wirings` and ask for a subfolder in the unknown-channel DM approval flow. Use when someone wants a channel to 'work in its own folder', a 'separate project dir per wiring', per-project MCP servers that don't leak to other chats, or asks about the `work_subdir` column."
---

# Add per-wiring working subfolder (`work_subdir`)

Runs a wiring's container with cwd at `/workspace/agent/<work_subdir>` instead of the shared group dir. The subfolder is an isolated project space — own files, own git repo, own project-scoped Codex MCP servers and skills — that **still inherits** the group's global MCP/skill config, because Codex ≥ 0.144.5 merges a *trusted* project's `.codex/config.toml` with the global one. `work_subdir` is null by default, so existing wirings keep working in the shared `/workspace/agent` unchanged. Memory and conversation history stay **global** (shared group assets), never per-subfolder.

> **Large integration surface, by nature.** This feature is cross-cutting: it touches the DB layer, the `ncl` CLI, the host container-runner, and the container agent-runner (config, cwd, `send_file`, Codex trust). Most reach-ins are single-line calls into the skill-owned `work-subdir.ts` helper or small field/param additions, but there are many of them. Apply exactly; the shipped tests catch drift.

## Phase 1: Pre-flight

Treat the skill as fully applied only when all four markers exist: `src/work-subdir.ts`, `src/modules/permissions/work-subdir-approval.ts`, `src/modules/permissions/index.ts` contains `promptForWorkSubdir`, and `ncl wirings help` lists `--work-subdir`. If any marker is missing, continue through Phase 2. Otherwise skip to Phase 4 (Verify) unless reapplying after an upstream update. Reapply is safe: each instruction below checks for the desired state and adds or replaces it exactly once.

## Phase 2: Apply code changes

### 2a. Copy the skill's files into both trees

```bash
S=.claude/skills/work-subdir
# Host (Node) tree
cp "$S/work-subdir.ts"              src/work-subdir.ts
cp "$S/020-wiring-work-subdir.ts"   src/db/migrations/020-wiring-work-subdir.ts
cp "$S/work-subdir-cli.test.ts"     src/work-subdir-cli.test.ts
cp "$S/work-subdir-approval.ts"      src/modules/permissions/work-subdir-approval.ts
cp "$S/work-subdir-approval.test.ts" src/modules/permissions/work-subdir-approval.test.ts
# Container (Bun) tree
cp "$S/work-subdir-codex.test.ts"   container/agent-runner/src/providers/work-subdir-codex.test.ts
```

`work-subdir.ts` exports `validateWorkSubdir` — the single validation source both the CLI and the host spawn call.

### 2b. Register migration 020

In `src/db/migrations/index.ts`, ensure the import and the array entry (append after `migration019`):

```ts
import { migration020 } from './020-wiring-work-subdir.js';
```
```ts
export const migrations: Migration[] = [
  // …existing entries…
  migration019,
  migration020,
];
```

### 2c. DB layer

`src/types.ts` — ensure `MessagingGroupAgent` has (after `threads?`):

```ts
  work_subdir?: string | null;
```

`src/db/schema.ts` — ensure the reference schema documents the column on `messaging_group_agents` (after `threads`): a `work_subdir TEXT` line. Cosmetic (the reference copy); the migration is what creates the column.

`src/db/messaging-groups.ts` — ensure this exported function exists (used by the container.json materializer for the union trust list):

```ts
export function getWorkSubdirsForAgentGroup(agentGroupId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT work_subdir FROM messaging_group_agents
         WHERE agent_group_id = ? AND work_subdir IS NOT NULL AND work_subdir != ''
         ORDER BY work_subdir`,
      )
      .all(agentGroupId) as { work_subdir: string }[]
  ).map((r) => r.work_subdir);
}
```

Also add the persistence helper the onboarding wiring path (2i) uses — `createMessagingGroupAgent` does not write the column:

```ts
export function setWiringWorkSubdir(id: string, workSubdir: string | null): void {
  getDb().prepare('UPDATE messaging_group_agents SET work_subdir = ? WHERE id = ?').run(workSubdir, id);
}
```

`src/db/index.ts` — ensure both `getWorkSubdirsForAgentGroup` and `setWiringWorkSubdir` are in the `export { … } from './messaging-groups.js'` block.

### 2d. `ncl wirings` — the `--work-subdir` flag + F1 guard

In `src/cli/resources/wirings.ts`:

1. Import the validator and declare the F1 error:
```ts
import { validateWorkSubdir } from '../../work-subdir.js';

const WORK_SUBDIR_AGENT_SHARED_ERROR =
  'work-subdir cannot be combined with session_mode=agent-shared (that mode shares one session across all wirings, so a per-wiring working dir has no effect)';
```
2. Add a `work_subdir` column (type `string`, `updatable: true`) to the `columns` array — before `priority`.
3. In `preUpdate`, after the `threads` normalization, normalize/validate and enforce F1 on the merged row:
```ts
    if (updates.work_subdir !== undefined) {
      const raw = String(updates.work_subdir).trim();
      updates.work_subdir = raw ? validateWorkSubdir(raw) : null;
    }
    const mergedMode = updates.session_mode ?? current.session_mode;
    const mergedSubdir = updates.work_subdir !== undefined ? updates.work_subdir : current.work_subdir;
    if (mergedMode === 'agent-shared' && mergedSubdir) {
      throw new Error(WORK_SUBDIR_AGENT_SHARED_ERROR);
    }
```
4. In the custom `create` handler, after the static `session_mode`/`priority` defaults are resolved:
```ts
        if (args.work_subdir !== undefined) {
          const raw = String(args.work_subdir).trim();
          if (raw) {
            if (values.session_mode === 'agent-shared') throw new Error(WORK_SUBDIR_AGENT_SHARED_ERROR);
            values.work_subdir = validateWorkSubdir(raw);
          }
        }
```
5. Add `--work-subdir` to the create verb's description flag list.

`src/work-subdir-cli.test.ts` guards this: the flag, F1 on both create and update, the migration column, and `getWorkSubdirsForAgentGroup`.

### 2e. Host container-runner — resolve + provision + env

In `src/container-runner.ts`:

1. Imports:
```ts
import { ChildProcess, exec, execFileSync, spawn } from 'child_process';
import { getMessagingGroupAgentByPair } from './db/messaging-groups.js';
import { validateWorkSubdir } from './work-subdir.js';
```
2. Add the two helpers (before `resolveProviderContribution`):
```ts
export function resolveSessionWorkSubdir(session: Session): string | null {
  if (!session.messaging_group_id) return null;
  const wiring = getMessagingGroupAgentByPair(session.messaging_group_id, session.agent_group_id);
  const raw = wiring?.work_subdir?.trim();
  if (!raw) return null;
  try {
    return validateWorkSubdir(raw);
  } catch (err) {
    log.warn('Ignoring invalid work_subdir on wiring — falling back to the shared group dir', {
      sessionId: session.id, raw, err,
    });
    return null;
  }
}

function provisionWorkSubdir(groupDir: string, subdir: string): void {
  const abs = path.join(groupDir, subdir);
  fs.mkdirSync(abs, { recursive: true });
  if (!fs.existsSync(path.join(abs, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: abs, stdio: 'ignore' });
    } catch (err) {
      log.warn('git init failed for work subdir — project-scoped skills will be unavailable there', { abs, err });
    }
  }
}
```
3. In `spawnContainer`, after `buildMounts(...)` and before `containerName`:
```ts
  const workSubdir = resolveSessionWorkSubdir(session);
  if (workSubdir) provisionWorkSubdir(path.resolve(GROUPS_DIR, agentGroup.folder), workSubdir);
```
Pass `workSubdir` as the final argument to `buildContainerArgs(...)`.
4. Give `buildContainerArgs` a trailing `workSubdir?: string | null` parameter, and after the `TZ` env push add:
```ts
  if (workSubdir) args.push('-e', `NANOCLAW_WORK_SUBDIR=${workSubdir}`);
```

`resolveSessionWorkSubdir` is guarded by `work-subdir-cli.test.ts`; the `buildContainerArgs` signature/env line is guarded by the typecheck leg.

### 2f. Host container-config — materialize the union

In `src/container-config.ts`:
```ts
import { getWorkSubdirsForAgentGroup } from './db/messaging-groups.js';
```
Add `workSubdirs?: string[];` to the `ContainerConfig` interface, and in `materializeContainerJson`, after `configFromDb(...)`:
```ts
  const workSubdirs = getWorkSubdirsForAgentGroup(agentGroupId);
  if (workSubdirs.length > 0) config.workSubdirs = workSubdirs;
```

### 2g. Container agent-runner

`container/agent-runner/src/config.ts` — add `workSubdirs?: string[];` to `RunnerConfig`, and in `loadConfig`'s returned object:
```ts
    workSubdirs: Array.isArray(raw.workSubdirs) ? (raw.workSubdirs as string[]) : undefined,
```

`container/agent-runner/src/providers/types.ts` — add to `ProviderOptions`:
```ts
  trustedWorkspaces?: string[];
```

`container/agent-runner/src/index.ts` — replace the `const CWD = '/workspace/agent'` line with `AGENT_ROOT` + a `resolveCwd()` that joins `process.env.NANOCLAW_WORK_SUBDIR` under `AGENT_ROOT` (with a defensive `fs.mkdirSync`). In `main`, compute `const cwd = resolveCwd()` and `const trustedWorkspaces = (config.workSubdirs ?? []).map((s) => path.join(AGENT_ROOT, s))` (push `cwd` if not already present). Set the nanoclaw MCP server's `env` to `{ NANOCLAW_AGENT_CWD: cwd }`, pass `trustedWorkspaces` in the `createProvider` options, and pass `cwd` (not `CWD`) to `runPollLoop`.

`container/agent-runner/src/mcp-tools/core.ts` — add near the top:
```ts
const AGENT_CWD = process.env.NANOCLAW_AGENT_CWD || '/workspace/agent';
```
and in `send_file`, resolve the base against `AGENT_CWD`:
```ts
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(AGENT_CWD, filePath);
```

`container/agent-runner/src/providers/codex-app-server.ts` — give `writeCodexConfigToml`'s opts a `trustedProjects?: string[]`, and after the model/effort lines write one trusted block per project (deduped + sorted):
```ts
  const trusted = [...new Set(opts.trustedProjects ?? [])].sort();
  for (const projectPath of trusted) {
    lines.push(`[projects.${tomlBasicString(projectPath)}]`);
    lines.push(`trust_level = "trusted"`);
    lines.push('');
  }
```

`container/agent-runner/src/providers/codex.ts` — store `this.trustedProjects = options.trustedWorkspaces` in the constructor and pass `trustedProjects: self.trustedProjects` in the `writeCodexConfigToml(...)` call inside `gen()`.

`work-subdir-codex.test.ts` guards the Codex trust block.

### 2h. Onboarding wiring — surface `work_subdir` at wire time

So the guided wiring flows can set a subfolder (not just `ncl wirings create --work-subdir`), thread the flag through the setup register step and ask for it in the wiring skill.

`setup/register.ts`:
1. Import the validator and the persistence helper:
```ts
import { setWiringWorkSubdir } from '../src/db/messaging-groups.js';
import { validateWorkSubdir } from '../src/work-subdir.js';
```
2. Add `workSubdir?: string;` to `RegisterArgs`.
3. In `parseArgs`, handle the flag (validate here so a bad value fails the step):
```ts
      case '--work-subdir': {
        const raw = (args[++i] || '').trim();
        if (raw) result.workSubdir = validateWorkSubdir(raw);
        break;
      }
```
and after the parse loop enforce F1:
```ts
  if (result.workSubdir && result.sessionMode === 'agent-shared') {
    throw new Error('--work-subdir cannot be combined with --session-mode agent-shared');
  }
```
4. In the `newlyWired` branch, right after `createMessagingGroupAgent(...)`, persist it:
```ts
    if (parsed.workSubdir) setWiringWorkSubdir(mgaId, parsed.workSubdir);
```
Optionally add `WORK_SUBDIR: parsed.workSubdir ?? ''` to the emitted `REGISTER_CHANNEL` status.

`.claude/skills/manage-channels/SKILL.md` — append, after the Isolation Question, a short "Work-subfolder Question" step: ask only when this skill is installed (`ncl wirings help` lists `--work-subdir`) and the isolation answer was not agent-shared (F1); take a relative path and pass `--work-subdir "<path>"` to the register command. Add `--work-subdir "<relative/path>"` to the register command's optional-overrides list.

`work-subdir-cli.test.ts` behavior-tests `setWiringWorkSubdir`; the register reach-in is guarded by the build/typecheck leg (register imports `validateWorkSubdir` + `setWiringWorkSubdir`, so a drift fails typecheck — `setup/register.ts` writes to the fixed `DATA_DIR`, so a hermetic run test isn't practical).

### 2i. Ask for `work_subdir` before unknown-channel wiring

The DM approval flow defers wiring and replay until the approver replies with a relative subfolder or a shared-folder choice. `work-subdir-approval.ts` owns the in-memory arming, validation, retry prompt, and router interceptor; keep the reach-ins in `src/modules/permissions/index.ts` small.

1. Ensure `setWiringWorkSubdir` appears exactly once in the existing import from `../../db/messaging-groups.js`. Ensure these two imports exist exactly once:

```ts
import { getDb } from '../../db/connection.js';
import { promptForWorkSubdir } from './work-subdir-approval.js';
```

2. Ensure `wireApprovedChannel` has this trailing optional argument:

```ts
async function wireApprovedChannel(
  row: PendingChannelApproval,
  agentGroupId: string,
  approverId: string,
  workSubdir: string | null = null,
): Promise<boolean> {
  // existing body
}
```

Move wiring creation, optional `setWiringWorkSubdir`, sender admission, and pending-row deletion into one synchronous `getDb().transaction(() => { ... })()` block. Keep `routeInbound(event)` after the transaction. This makes wiring plus subfolder persistence atomic and ensures the first replay sees the stored subfolder:

```ts
  getDb().transaction(() => {
    createMessagingGroupAgent({
      // existing fields
    });
    if (workSubdir) setWiringWorkSubdir(mgaId, workSubdir);

    const senderUserId = extractAndUpsertUser(event);
    if (senderUserId) {
      addMember({
        user_id: senderUserId,
        agent_group_id: agentGroupId,
        added_by: approverId,
        added_at: new Date().toISOString(),
      });
    }
    deletePendingChannelApproval(row.messaging_group_id);
  })();
```

3. In the `connect:<id>` response path, ensure the direct `wireApprovedChannel(...)` call is replaced exactly once with:

```ts
  await promptForWorkSubdir({
    row,
    agentGroupId: targetAgentGroupId,
    approverId,
    complete: wireApprovedChannel,
  });
```

4. In the free-text new-agent interceptor, after `createNewAgentGroup(...)`, ensure the direct wiring and its old connected/error confirmation block are replaced exactly once with:

```ts
  await promptForWorkSubdir({
    row,
    agentGroupId: ag.id,
    approverId: userId,
    complete: wireApprovedChannel,
  });
```

5. In `src/modules/permissions/channel-approval.test.ts`, ensure one `chooseSharedWorkFolder()` helper routes the owner's next DM with `{ text: 'no' }`. Ensure it is called once after each of the two direct connect-response loops, inside `approvePending`, after the new-agent name reply in the identical-wirings test, and after the name reply in the create-new-agent test. These existing tests continue through the new mandatory choice before asserting their original wiring behavior.

6. In `src/modules/permissions/channel-approval.ts`, keep the direct `connect:<id>` option when exactly one agent is visible, and ensure a separate `if (visibleAgentGroups.length > 0)` block also adds `CHOOSE_EXISTING_VALUE`. Do not use `else if`: the chooser is the restart-recovery path after a new agent is created. Update the module header so both connect paths say they ask for a working folder before wiring and replay.

7. Update the adjacent comments in `src/modules/permissions/index.ts` so the `wireApprovedChannel` doc says both paths complete after choosing a working folder, the value-dispatch comments say `connect:<id>` asks for a folder and `new_agent` creates then asks, and the name-interceptor comment says it asks before wiring and replay. In `channel-approval.test.ts`, update the identical-wirings comment so it no longer says the name reply wires immediately. Check the existing comment text before replacing it so reapply never duplicates anything.

`work-subdir-approval.test.ts` drives the real response handler and router interceptor. It guards both prompt call sites, deferred wiring, the always-available recovery chooser, same-approver prompt serialization and stale-prompt cleanup, shared-folder choices, invalid-path retry, new-agent flow, atomic rollback/retry, and persistence before the first container wake.

### 2j. Validate

```bash
export PATH="/Users/tuanhv/.nvm/versions/node/v22.22.1/bin:$PATH"   # repo pins Node 22; the machine default breaks better-sqlite3
pnpm run build
pnpm exec vitest run src/work-subdir-cli.test.ts src/modules/permissions/work-subdir-approval.test.ts src/modules/permissions/channel-approval.test.ts
(export PATH="/Users/tuanhv/.bun/bin:$PATH"; cd container/agent-runner && bun run typecheck && bun test src/providers/work-subdir-codex.test.ts)
```

All must be clean. Then rebuild the container image so sessions pick up the runner changes:

```bash
./container/build.sh
# restart the host — macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw ; Linux: systemctl --user restart nanoclaw
```

## Phase 3: Use it

```bash
ncl wirings create --messaging-group-id <mg> --agent-group-id <ag> --work-subdir projects/alpha
ncl wirings update --id <wiring-id> --work-subdir projects/alpha
ncl wirings update --id <wiring-id> --work-subdir ""     # clear → back to the shared group dir
```

Constraints (enforced at the CLI and re-checked at spawn): relative only (no leading `/`), no `..` segments, and **rejected when `session_mode = agent-shared`** (F1 — that mode collapses all wirings into one session, so a per-wiring cwd can't track it). The path is normalized (`./a//b/` → `a/b`). Null/absent = the shared `/workspace/agent`. Takes effect on the wiring's next container spawn (a plain wiring change needs no image rebuild — only editing the agent-runner does).

Unknown-channel approval asks in the approver's DM before it creates the wiring. Reply with a relative path, or `no`, `skip`, `shared`, `không`, `khong`, `n`, or an empty message to use the shared group directory. Invalid paths keep the prompt armed so the next DM can retry.

## Phase 4: Verify

- `ncl wirings help` lists `--work-subdir`; `ncl wirings get --id <id>` shows the stored `work_subdir`.
- Wire a test channel with `--work-subdir projects/test`, send it a message, and confirm the agent's files land in `groups/<folder>/projects/test/` and `send_file` with a relative path resolves there.
- For Codex project-scoped MCP: drop a `.codex/config.toml` with an extra MCP server inside the subfolder and confirm `codex mcp list` (cwd = the subfolder) shows both it and the global servers.

## How it works (anatomy)

| Stage | File | Role |
|-------|------|------|
| Storage | `020-wiring-work-subdir.ts`, `schema.ts`, `types.ts` | nullable `work_subdir` column |
| Validation | `work-subdir.ts` | `validateWorkSubdir` — one source of truth |
| CLI | `cli/resources/wirings.ts` | `--work-subdir` + F1 guard |
| Onboarding | `setup/register.ts` + `db/messaging-groups.ts` (`setWiringWorkSubdir`) + `/manage-channels` | wire-time `--work-subdir` (guided flows) |
| DM approval | `modules/permissions/work-subdir-approval.ts` + `permissions/index.ts` | ask before wiring, capture reply, persist before replay |
| Union | `db/messaging-groups.ts` | `getWorkSubdirsForAgentGroup` |
| Spawn | `container-runner.ts` | resolve subdir, mkdir + `git init` (F2), `-e NANOCLAW_WORK_SUBDIR` |
| Union → container.json (F4) | `container-config.ts` | `workSubdirs` (per-group, race-safe) |
| Runner cwd | agent-runner `index.ts` | cwd = `/workspace/agent/<subdir>`, publishes `NANOCLAW_AGENT_CWD` |
| send_file (F3) | `mcp-tools/core.ts` | resolve relative paths against the cwd |
| Codex trust (B) | `providers/codex-app-server.ts` + `codex.ts` + `types.ts` | `trusted` block per union subdir |

## Gotchas

- **Codex version.** Project `.codex/config.toml` merges with global only for a *trusted* cwd, and only on Codex ≥ 0.144.5. The trust block is what enables the merge.
- **MCP vs skills.** Project MCP needs only the trust block; project *skills* also need the subfolder to be a git repo (hence `git init` in `provisionWorkSubdir`). Global skills go through `$HOME/.agents/skills` and are always inherited.
- **self-mod writes global.** `add_mcp_server` / `install_packages` change the group's `container.json` (whole group). Per-subfolder MCP is the agent writing `.codex/config.toml` inside the subfolder, not self-mod.
- **Two env vars, one concept.** `NANOCLAW_WORK_SUBDIR` (host→runner, relative) becomes `NANOCLAW_AGENT_CWD` (runner→MCP, absolute). Keep them consistent.
- **DM capture is in memory.** A host restart while waiting loses the next-message arming, but the durable pending approval row and original card remain. For an existing target, click its connect option again. If a new agent was already created, choose that agent through **Choose existing**; clicking **Connect new agent** creates another agent. No wiring or replay happens before a valid reply.
- **Next-DM prompts are sequential.** A second work-subfolder prompt for the same approver is refused until the first completes. Agent naming and reject-with-reason still use the router's existing ordered interceptor pattern, so finish those prompts before opening a different prompt type for the same approver.
- Repo rules still apply: ISO-UTC timestamps, `minimumReleaseAge` for pnpm, `bun install` (not pnpm) for agent-runner deps.

## Troubleshooting

| Symptom | Cause | Check |
|---------|-------|-------|
| `--work-subdir` rejected | agent-shared or bad path | not `session_mode=agent-shared`; relative, no `..` |
| Project MCP not loaded | missing trust or old Codex | `config.toml` has `[projects."<abs>"] trust_level="trusted"`; Codex ≥ 0.144.5 |
| Project skills not found | subfolder not a git repo | `.git` exists in the subfolder |
| Agent still in `/workspace/agent` | no subdir or not respawned | `ncl wirings get` shows `work_subdir`; wiring spawned a fresh container since the change |
| `send_file` can't find a just-made file | stale image | rebuilt `container/agent-runner/` (`./container/build.sh`) + restarted host |
| Subfolder reply is ignored after a restart | in-memory DM capture was lost | click connect again; for an already-created agent, use **Choose existing** and select it before replying |
