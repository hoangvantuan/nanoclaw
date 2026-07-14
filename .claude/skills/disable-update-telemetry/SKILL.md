---
name: disable-update-telemetry
description: "Permanently opt out of the update-nanoclaw diagnostics telemetry (the PostHog 'send diagnostics?' prompt at the end of an update). Applies upstream's own built-in 'Never ask again' outcome so it survives re-runs. Use after a fresh checkout, `git reset --hard upstream/main`, or `/update-nanoclaw`/`/update-skills` restores the upstream update-nanoclaw skill. Triggers: \"disable telemetry\", \"opt out diagnostics\", \"stop the posthog prompt\", \"never ask again update\"."
---

# Disable update-nanoclaw diagnostics telemetry

The upstream `update-nanoclaw` skill ends with a `## Diagnostics` step that reads
`diagnostics.md` and asks (via PostHog) whether to send anonymised update
metrics. That skill already documents a **"Never ask again"** outcome; this skill
applies it deterministically so the prompt never appears again — and re-applies
it after any upstream update restores the original files.

This is idempotent and re-runnable. It only edits the `update-nanoclaw` skill's
own files; it changes no core code.

## When to use

- After `git reset --hard upstream/main` or a fresh checkout.
- After `/update-nanoclaw` / `/update-skills` overwrites `.claude/skills/update-nanoclaw/`
  with upstream copies (which re-enable the prompt).

## Apply

1. **Replace `diagnostics.md` with the opted-out marker:**
   ```bash
   printf '# Diagnostics — opted out\n' > .claude/skills/update-nanoclaw/diagnostics.md
   ```

2. **Remove the `## Diagnostics` section from the update-nanoclaw `SKILL.md`.**
   Delete the trailing section (the `## Diagnostics` heading and the two steps
   that read/follow `diagnostics.md`). If the section is already gone, skip.
   Verify:
   ```bash
   grep -n '## Diagnostics' .claude/skills/update-nanoclaw/SKILL.md || echo "already removed"
   ```

## Verify

```bash
test "$(cat .claude/skills/update-nanoclaw/diagnostics.md)" = '# Diagnostics — opted out' \
  && ! grep -q '## Diagnostics' .claude/skills/update-nanoclaw/SKILL.md \
  && echo OK || echo "NOT fully applied"
```

## Notes

- Nothing to `REMOVE` beyond restoring upstream: `git checkout upstream/main --
  .claude/skills/update-nanoclaw/SKILL.md .claude/skills/update-nanoclaw/diagnostics.md`
  brings the prompt back.
