# e2e-tester — Claude Code plugin

Zero-manual-work E2E test generator. pytest + Selenium, any backend language, discovered from the code itself.

## Install

```
/plugin marketplace add Aronbfrt/claude-e2e-tester
/plugin install e2e-tester@e2e-tester
```

## Commands

| Command | What it does |
|---|---|
| `/e2e-init` | Guided setup — copies the template, you (or Claude) fill in routes/forms step by step |
| `/e2e-audit` | Full automatic audit — discovers every route/form/entity via static code analysis, generates basic + SEO + security + accessibility + performance + responsive tests, runs them. Zero manual input. Idempotent: re-running syncs new routes without touching hand-edited tests. |

Natural-language triggers (if you map them in your own `CLAUDE.md`): "teste-moi le site", "audit le site", "test complet" → `/e2e-audit`.

## What you get

- **Page Object Model** — selectors live in `tests/pages/`, never inline in a test
- **Flat domain folders** — `tests/auth/`, `tests/admin/`, `tests/checkout/`... one feature = one place
- **Session-scoped browsers** — one browser per role for the whole run, scales to 1000+ tests
- **SEO checks** — title/meta/canonical/h1/alt/structured data/robots/sitemap, each failure explains why it matters
- **Security checks** — non-destructive: SQL error leakage, reflected-input escaping, security headers, sensitive path exposure, debug banners, admin auth bypass. Never destructive, never against prod.
- **Enriched HTML report** — failures embed screenshot + console errors directly in the row, dark theme, Category column (security gets a red 🔒 badge)
- **Zero install** — `tests/run.sh` auto-installs whatever pip package is missing
- **Works on any stack** — PHP, Java/Spring, Next.js, Django, Flask, Rails, Go, Rust, Elixir — route discovery adapts per marker file (`composer.json`, `pom.xml`, `manage.py`...)

See `templates/e2e/README.md` for the full structure reference once installed in a project.

## License

MIT
