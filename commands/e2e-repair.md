---
description: Autonomous bug repair — loads the last Coroner triage from disk, generates a surgical patch via Ghostwriter, applies it on a git branch, verifies tests pass, and opens a Pull Request. Triggers on "répare le bug", "auto-patch", "ghostwriter", "repair", /e2e-repair.
---

# /e2e-repair

Activates the Ghostwriter agent to autonomously fix a confirmed bug. Loads the most recent triage result from `.e2e-work/*.triage.json` (or a specific one via `--trace`), generates a patch, applies it on a dedicated branch, runs a targeted test re-run, and opens a Pull Request.

## Prerequisites

A triage file must exist in `.e2e-work/` — produced by `audit --level=2+` or `shadow --level=2+`. If none exists, run an audit first.

## Usage

```bash
# Load the latest triage automatically
node dist/index.js repair

# Target a specific triage by ID (visible in report.html)
node dist/index.js repair --trace=run-1718542800000

# On a specific project
node dist/index.js repair /path/to/project
```

## What Ghostwriter does

1. **Localise** — finds the source file for the failing route (URL slug + grep fallback)
2. **Generate patch** — sends compressed source + crash report to Claude Sonnet → receives `Patch[]`
3. **Apply on branch** — `git checkout -b e2e-patch/<timestamp>-<route>`
4. **Verify** — `npx playwright test --grep <route>` — only submits if tests pass
5. **Open PR** — `gh pr create` with bug description + fix explanation (fallback: draft `.md` in `.e2e-work/` if `gh` not installed)
6. **Update score** — Confidence Index recalculated and written to `report.html`
