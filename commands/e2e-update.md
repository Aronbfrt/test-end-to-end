---
description: Sync tests with code changes — detect new/changed/removed routes and update tests without overwriting manual edits. Triggers on "mettre à jour les tests", "sync les tests", "nouvelles routes", /e2e-update.
---

# /e2e-update

Après des changements dans le code (nouvelles routes, formulaires renommés, entités supprimées), resynchronise la suite de tests sans toucher aux tests écrits à la main.

## Step 1 — Redécouverte complète

Re-lancer la découverte statique (même logique que /e2e-audit Step 2) → état actuel de l'app.

## Step 2 — Lire l'état actuel des tests

Construire une map de ce qui est testé :
- Quelles routes sont couvertes (grep `driver.get`, `cy.visit`, `page.goto`, `Open Browser`)
- Quels sélecteurs sont utilisés (lire `tests/pages/*.py` ou `cypress/support/pages/`)
- Quels tests sont marqués `# migrated from`, `# converted from` vs écrits à la main

**Distinguer tests générés vs manuels :** un test sans ces marqueurs est manuel → ne jamais le modifier automatiquement.

## Step 3 — Diff et actions

| Changement détecté | Action |
|---|---|
| Nouvelle route sans test | Générer le test dans le bon dossier (comme Step 3 de /e2e-audit) |
| Nouveau champ dans formulaire existant | Ajouter le sélecteur dans `pages/*.py`, ajouter assertion dans le test existant |
| Route supprimée | Marquer le test `@pytest.mark.xfail(reason="route supprimée ? à vérifier")` — **jamais supprimer** |
| Sélecteur CSS/name renommé dans le HTML | Mettre à jour `pages/*.py` uniquement — pas le fichier de test |
| Nouvelle entité CRUD admin | Créer `tests/admin_<entité>/` comme /e2e-audit Step 3 |
| Route existante, URL changée | Mettre à jour le path dans le test généré — pas dans les tests manuels |

**Règles absolues :**
- Jamais supprimer un test — même si la route n'existe plus
- Jamais modifier le corps d'un test marqué comme manuel (sans `# migrated from` ni `# converted from`)
- Modifier les Page Objects (`pages/*.py`) en premier — les tests s'adaptent automatiquement

## Step 4 — Rapport de synchronisation

```
🔄 SYNC REPORT — <ProjectName>
════════════════════════════════════════

➕ AJOUTÉS (N)
  + GET  /api/webhooks         → tests/api/test_webhooks.py (généré)
  + POST /products/bulk-import → tests/products/test_bulk_import.py (généré)

⚠ FLAGGÉS (N)
  ⚠ GET  /old-checkout         → tests/checkout/test_checkout.py::TestCheckout::test_flow
      [route introuvable dans le code — marqué xfail]

🔧 SÉLECTEURS MIS À JOUR (N)
  ~ /contact  field "nom" → "first_name"  dans tests/pages/public_pages.py

─ INCHANGÉS (N)
  Tests manuels non touchés : N
  Tests générés à jour : N
```

## Step 5 — Relancer les tests impactés

Après le sync, lancer uniquement les tests modifiés/ajoutés pour valider :

```bash
# selenium/playwright-python
pytest --headed tests/<nouveaux_dossiers>/ --tb=short

# cypress
npx cypress run --spec "cypress/e2e/<nouveaux>/**" --headed

# robot
robot tests/<nouveaux>/
```
