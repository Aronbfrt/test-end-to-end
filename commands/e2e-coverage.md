---
description: Show test coverage map — which routes/forms/APIs have tests and which don't. Triggers on "couverture des tests", "quelles routes sont testées", "coverage", /e2e-coverage.
---

# /e2e-coverage

Scans the project code to find all routes and forms, cross-references with existing test files, and produces a coverage map showing gaps.

## Step 1 — Découverte des routes (même logique que /e2e-audit Step 2)

Re-lancer la découverte statique complète selon le stack détecté. Pas de crawl live.
Construire une liste normalisée : `METHOD PATH` (ex: `GET /products`, `POST /contact`).

## Step 2 — Extraire les chemins testés depuis les fichiers existants

Lire `TEST_FRAMEWORK` dans `.env.test` pour savoir où et quoi chercher :

```bash
# selenium / playwright-python → tests/**/*.py
grep -rE "driver\.get|page\.goto|url\(|\.get\(url|BASE_URL" tests/ 2>/dev/null

# playwright-ts → tests/**/*.spec.ts
grep -rE "page\.goto|baseURL|navigate" tests/ 2>/dev/null

# cypress → cypress/e2e/**/*.cy.js
grep -rE "cy\.visit|baseUrl" cypress/e2e/ 2>/dev/null

# robot → tests/**/*.robot
grep -rE "Open Browser|Go To|Navigate To" tests/ 2>/dev/null
```

Si `TEST_FRAMEWORK` absent de `.env.test` → tenter les 4 greps et merger les résultats.

Normaliser : supprimer trailing slash, query params, `TEST_BASE_URL` prefix → garder le path seul.

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
  ✓ GET  /                    → <chemin test selon framework>::<nom test>
  ✓ POST /contact             → <chemin test selon framework>::<nom test>

⚠ PARTIEL (N)
  ⚠ GET  /products            → visité mais sans assertion métier

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
