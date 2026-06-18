---
description: Zero-prompt Reverse Testing with Shadow Personas — generates tests for 4 extreme user profiles (Frustrated, Malicious Attacker, Chaos Network, Impulsive Buyer) without any manual input. Triggers on "shadow personas", "reverse testing", "test attacker", "test sécurité personas", /e2e-shadow.
---

# /e2e-shadow

Runs the Shadow Personas suite on the target project. Deconstructs the AST to map every route and form, then generates inferred E2E tests covering 4 extreme behavioral profiles — no feature description needed.

## What each persona generates

- **Frustrated User** — rage-clicks, form abandonment mid-way, repeated submission, back-navigation during checkout
- **Malicious Attacker** — XSS (6 payloads), SQL injection (5 payloads), path traversal (3 payloads), prompt injection on AI routes
- **Chaos Network** — mid-submit disconnect, 3G throttling (200ms/req), double-click idempotency check
- **Impulsive Buyer** — skip required fields, bypass validation steps, direct-to-payment without cart

## Usage

```bash
# Default — all 4 personas, level 2 (Vision QA active)
node dist/index.js shadow --level=2

# Add network fault simulation
node dist/index.js shadow --level=2 --chaos

# Full run: personas + chaos + auto-patch if bugs found
node dist/index.js shadow --level=3 --chaos

# On a specific project
node dist/index.js shadow /path/to/project --level=2
```

## Output

Tests written to `tests/shadow/` in the target project, grouped by persona. Each test file is named `<persona>-<route-slug>.spec.ts`.

If `--level=3`, any confirmed BACKEND_BUG triggers Ghostwriter → PR created automatically.
