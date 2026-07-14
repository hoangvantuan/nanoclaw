# Remove disable-update-telemetry

Restore the upstream `update-nanoclaw` diagnostics prompt (undo the opt-out):

```bash
git checkout upstream/main -- \
  .claude/skills/update-nanoclaw/SKILL.md \
  .claude/skills/update-nanoclaw/diagnostics.md
```

If `upstream/main` isn't a configured remote ref, use whatever ref points at a
clean upstream copy (e.g. `origin/main`).
