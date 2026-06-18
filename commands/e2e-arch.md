---
description: Architecture analysis of TypeScript/JavaScript code. Detects functions that are too long, high cyclomatic complexity, oversized files, excessive imports. Generates a scored report 0-100. Triggers on "analyse l'architecture", "complexité du code", "arch police", /e2e-arch.
---

# /e2e-arch

Runs ArchPolice on the project's TypeScript and JavaScript source files. Measures 4 architectural metrics, assigns a score from 0 to 100, and generates a detailed report listing every violation sorted by severity.

## Usage

```bash
# Analyze the current project
node dist/index.js arch

# Analyze a specific project
node dist/index.js arch /path/to/project

# Read the report
cat .e2e-work/arch-report.md

# Via dashboard
GET http://127.0.0.1:4321/api/arch

# Via MCP tool
e2e_arch({ targetPath: "/path/to/project" })
```

## Metrics and thresholds

| Metric | Threshold | Why it matters |
|---|---|---|
| Function length | > 80 lines | Hard to test and understand |
| Cyclomatic complexity | > 10 branches | Too many execution paths |
| File size | > 500 lines | Responsibility too broad |
| Import count | > 15 imports | Excessive coupling |

Complexity counts: `if`, `else`, `for`, `while`, `case`, `??`, `?.`, `&&`, `\|\|`, `switch`, `catch`

## Score formula

```
Score = 100 − (violations / files_analyzed × 10)
→ capped between 0 and 100
```

| Score | Interpretation |
|---|---|
| 80–100 | Healthy architecture |
| 60–79 | A few files to refactor |
| 40–59 | Visible technical debt |
| < 40 | Architecture degraded — refactoring urgent |

## Output files

- `.e2e-work/arch-report.json` — raw data per file
- `.e2e-work/arch-report.md` — readable Markdown report with violations sorted by severity
