---
description: OWASP security audit on a GitHub Pull Request diff. Detects hardcoded secrets, SQL injection, SSRF, eval/exec, XSS, IDOR, RCE via Ollama local LLM (or regex fallback). Triggers on "audit sécurité PR", "sentinel", "check la PR", /e2e-sentinel.
---

# /e2e-sentinel

Runs the Sentinel agent on a GitHub Pull Request. Fetches the PR diff via `gh` CLI, analyzes it with Ollama (local LLM, 0 tokens) or regex fallback, and reports OWASP vulnerabilities with file, line, severity, and suggested fix.

## Prerequisites

- `GITHUB_TOKEN` in `.env`
- `gh` CLI installed and authenticated (`gh auth login`)
- Ollama optional — if absent, regex analysis runs instead (9 static OWASP patterns)

## Usage

```bash
# Audit PR #42 on the current repo
node dist/index.js sentinel --pr=42

# Audit PR on a specific repo
node dist/index.js sentinel --pr=42 --repo=owner/my-project

# Via MCP tool
e2e_sentinel({ targetPath: "/path/to/project", prNumber: 42 })
```

## What Sentinel detects

| Pattern | Severity |
|---|---|
| Hardcoded secrets (passwords, tokens, API keys) | HIGH |
| SQL injection (`query(` + user input) | HIGH |
| SSRF (user-controlled URLs in fetch/axios) | HIGH |
| `eval()` / `exec()` with user input | HIGH |
| Unfiltered `readFileSync` with user input | HIGH |
| XSS (`innerHTML` + user input, no sanitization) | MEDIUM |
| IDOR (user ID in URL without authorization check) | MEDIUM |
| Shell injection (`exec` / `spawn` + user input) | HIGH |
| RCE patterns | HIGH |

## Output

A JSON array of findings, each with:
- `file` — path of the vulnerable file
- `line` — line number
- `severity` — HIGH / MEDIUM / LOW
- `description` — human-readable explanation
- `suggestion` — recommended fix

A Slack/Discord/Teams notification is sent if webhooks are configured.
