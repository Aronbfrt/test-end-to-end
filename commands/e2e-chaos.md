---
description: Network chaos injection — generates Playwright specs that intercept HTTP requests via page.route() to simulate 6 failure scenarios: latency, timeout, HTTP 50x, offline, corrupt JSON, partial response. Triggers on "chaos réseau", "test de résilience", "injecte du chaos", /e2e-chaos.
---

# /e2e-chaos

Runs ChaosMonkey on the detected routes. For each route (up to 10), generates 6 Playwright spec files that intercept browser network requests to simulate real-world failure conditions.

## Usage

```bash
# Generate chaos specs for the current project (port 3000)
node dist/index.js chaos

# With a custom server port
node dist/index.js chaos --port=8080

# On a specific project
node dist/index.js chaos /path/to/project --port=4000

# Via MCP tool
e2e_chaos({ targetPath: "/path/to/project", port: 3000 })
```

## The 6 chaos scenarios

| Scenario | What is simulated | What is verified |
|---|---|---|
| `LATENCY` | 3–5s delay on all API requests | Page displays no error, no crash |
| `TIMEOUT` | All API requests aborted (`ETIMEDOUT`) | No uncaught JavaScript exception |
| `ERROR_50x` | API returns HTTP 500 / 503 | No raw stack trace exposed to user |
| `OFFLINE` | All network requests blocked | Page is not blank, has content |
| `CORRUPT` | API returns syntactically invalid JSON | No uncaught `SyntaxError` propagated |
| `PARTIAL` | API returns truncated JSON response | No raw error message shown to user |

## Generated files

For each route `/dashboard`, specs are created at:
```
tests/dashboard/
  chaos_latency_dashboard_<uid>.spec.ts
  chaos_timeout_dashboard_<uid>.spec.ts
  chaos_error_50x_dashboard_<uid>.spec.ts
  chaos_offline_dashboard_<uid>.spec.ts
  chaos_corrupt_dashboard_<uid>.spec.ts
  chaos_partial_dashboard_<uid>.spec.ts
```

## Run the generated specs

```bash
npx playwright test tests/ --grep "chaos:"
```

## Integration with audit

The `--chaos` flag activates ChaosMonkey automatically within the full audit pipeline:
```bash
node dist/index.js audit --chaos
node dist/index.js audit --level=3 --chaos --predictive
```
