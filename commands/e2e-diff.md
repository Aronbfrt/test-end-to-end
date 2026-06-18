---
description: Scoped E2E run on git-changed files only — reads `git diff HEAD` + staged files and generates/updates tests only for what changed. With --predictive, overlays 12-month Git forensics hotspot ranking. Triggers on "teste ce que j'ai changé", "diff tests", "test my changes", /e2e-diff.
---

# /e2e-diff

Runs a targeted audit scoped to the current git diff. Instead of scanning the whole project, only modified and staged files are analysed — ideal for pre-commit hooks or daily development flow.

## Usage

```bash
# Scope to git diff (HEAD + staged)
node dist/index.js diff

# Add Git forensics: also include historically risky files
node dist/index.js diff --predictive

# With Vision QA on selector failures
node dist/index.js diff --level=2 --predictive

# On a specific project path
node dist/index.js diff /path/to/project --level=2
```

## Flags

| Flag | Effect |
|---|---|
| `--predictive` | Reads 12 months of `git log`, ranks files by churn × stress, overlays top 15 hotspot files onto the diff scope |
| `--level=2` | Activates Vision QA for broken selectors (default) |
| `--level=3` | Full: personas + auto-patch |

## Output

Updates or creates tests in `tests/` for the changed routes only. Leaves untouched routes and manually-written tests intact.
