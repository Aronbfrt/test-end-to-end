---
description: Show test coverage map — which routes/forms/APIs have tests and which don't. Triggers on "couverture des tests", "quelles routes sont testées", "coverage", /e2e-coverage.
---

# /e2e-coverage

Scans the project code to find all routes and forms, cross-references with existing test files, and produces a coverage map showing gaps.

## Step 1 — Découverte des routes (même logique que /e2e-audit Step 2)

Re-lancer la découverte statique complète selon le stack détecté. Pas de crawl live.
Construire une liste normalisée : `METHOD PATH` (ex: `GET /products`, `POST /contact`).

## Step 2 — Extraire les chemins testés depuis les fichiers existants

Lire tous les fichiers de test et extraire les URLs/paths réellement testés :

```bash
# Python (selenium/playwright-python)
grep -r "driver\.get\|url(\|BASE_URL\|\.get(url" tests/ 2>/dev/null

# Playwright TS
grep -r "page\.goto\|baseURL\|\.navigate" tests/ 2>/dev/null

# Cypress
grep -r "cy\.visit\|baseUrl" cypress/e2e/ 2>/dev/null

# Robot Framework
grep -r "Open Browser\|Go To\|Navigate To" tests/ 2>/dev/null
```

Normaliser : supprimer trailing slash, query params, `BASE_URL` prefix → garder le path seul.

## Step 3 — Cross-reference et rapport

Comparer routes découvertes vs paths testés. Classifier chaque route :

- **✓ Couvert** — au moins un test visite et assert cette route
- **⚠ Partiel** — la route est visitée mais sans assertion métier (juste `status 200`)
- **✗ Non couvert** — aucun test ne touche cette route

Afficher dans ce format :

```
📊 COVERAGE MAP — <ProjectName>
════════════════════════════════════════════════

✓ COUVERT (N)
  ✓ GET  /                    → tests/public/test_public.py::TestPublic::test_home
  ✓ POST /contact             → tests/contact/test_contact.py::TestContact::test_submit

⚠ PARTIEL (N)
  ⚠ GET  /products            → visité dans test_public, pas d'assertion produit

✗ NON COUVERT (N)
  ✗ GET  /api/orders
  ✗ POST /api/orders
  ✗ GET  /admin/reports

────────────────────────────────────────────────
Coverage : XX% (N/M routes)
Sécurité : N formulaires sans test sécurité
```

## Step 4 — Recommandations

- Si coverage < 50% → "Lance `/e2e-audit` pour générer les tests manquants"
- Si coverage 50–80% → lister les routes non couvertes, proposer `/e2e-update`
- Si coverage > 80% → "Suite complète. Vérifie les routes partielles."
- Toujours signaler les formulaires sans test sécurité (injection/XSS) — indépendamment du coverage global
