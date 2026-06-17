---
description: Sync tests with code changes — detect new/changed/removed routes and update tests without overwriting manual edits. Triggers on "mettre à jour les tests", "sync les tests", "nouvelles routes", /e2e-update.
---

# /e2e-update

Après des changements dans le code (nouvelles routes, formulaires renommés, entités supprimées), resynchronise la suite de tests sans toucher aux tests écrits à la main.

## Step 1 — Redécouverte complète

Lire `TEST_FRAMEWORK` dans `.env.test` — détermine la syntaxe de skip, le dossier des Page Objects, et le runner final.

Re-lancer la découverte statique (même logique que /e2e-audit Step 2) → état actuel de l'app.

## Step 2 — Lire l'état actuel des tests

Construire une map de ce qui est testé :
- Quelles routes sont couvertes (grep `driver.get`, `cy.visit`, `page.goto`, `Open Browser`)
- Quels sélecteurs sont utilisés (lire `tests/pages/*.py` ou `cypress/support/pages/`)
- Quels tests portent un marqueur "généré automatiquement" vs écrits à la main :
  - Python : `# migrated from` / `# converted from`
  - TypeScript/JavaScript : `// migrated from` / `// converted from`
  - Robot : `[Documentation]    migrated from ...`

**Distinguer tests générés vs manuels :** un test sans ces marqueurs est manuel → ne jamais le modifier automatiquement.

## Step 3 — Diff et actions

| Changement détecté | Action |
|---|---|
| Nouvelle route sans test | Générer le test dans le bon dossier (comme Step 3 de /e2e-audit), format adapté au framework |
| Nouveau champ dans formulaire existant | Ajouter le sélecteur dans le Page Object, ajouter assertion dans le test existant |
| Route supprimée | Marquer le test comme skip/xfail (voir syntaxe ci-dessous) — **jamais supprimer** |
| Sélecteur CSS/name renommé dans le HTML | Mettre à jour le Page Object uniquement — pas le fichier de test |
| Nouvelle entité CRUD admin | Créer dossier feature comme /e2e-audit Step 3 |
| Route existante, URL changée | Mettre à jour le path dans les tests générés — jamais dans les tests manuels |

### Syntaxe "route supprimée" par framework

```python
# selenium / playwright-python
@pytest.mark.xfail(reason="route supprimée ? à vérifier")
def test_...(self, user_driver): ...
```
```typescript
// playwright-ts
test.skip('...', async ({ page }) => { /* route supprimée ? à vérifier */ });
```
```javascript
// cypress
it.skip('...', () => { /* route supprimée ? à vérifier */ });
```
```robot
# robot
*** Test Cases ***
<Test Name>
    [Tags]    skipped
    [Documentation]    route supprimée ? à vérifier
    Skip
```

### Page Objects par framework

| Framework | Fichier à modifier | Jamais modifier |
|---|---|---|
| selenium / playwright-python | `tests/pages/*.py` | fichier de test |
| playwright-ts | `tests/pages/*.ts` (ou `lib/pages/`) | `*.spec.ts` |
| cypress | `cypress/support/pages/*.js` | `*.cy.js` |
| robot | `tests/resources/*.resource` | `*.robot` |

**Règles absolues :**
- Jamais supprimer un test — même si la route n'existe plus
- Jamais modifier le corps d'un test sans marqueur `# migrated from` / `# converted from` (= manuel)
- Modifier les Page Objects en premier — les tests s'adaptent automatiquement

## Step 4 — Rapport de synchronisation

```
🔄 SYNC REPORT — <ProjectName>
════════════════════════════════════════

➕ AJOUTÉS (N)
  + GET  /api/webhooks         → <chemin selon framework> (généré)
  + POST /products/bulk-import → <chemin selon framework> (généré)

⚠ FLAGGÉS (N)
  ⚠ GET  /old-checkout         → <fichier test>::<test>
      [route introuvable dans le code — marqué skip/xfail]

🔧 SÉLECTEURS MIS À JOUR (N)
  ~ /contact  field "nom" → "first_name"  dans <Page Object selon framework>

─ INCHANGÉS (N)
  Tests manuels non touchés : N
  Tests générés à jour : N
```

## Step 5 — Relancer les tests impactés

Après le sync, lancer uniquement les tests modifiés/ajoutés pour valider :

```bash
# selenium / playwright-python
pytest --headed tests/<nouveaux_dossiers>/ --tb=short

# playwright-ts
npx playwright test tests/<nouveaux>/ --headed

# cypress
npx cypress run --spec "cypress/e2e/<nouveaux>/**" --headed

# robot
robot tests/<nouveaux>/
```
