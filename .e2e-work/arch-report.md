# Rapport Arch Police

**Score:** 39/100 🔴 Grade **F**  
**Fichiers analysés:** 28  
**Violations:** 39  
**Généré le:** 2026-06-18T14:12:42.558Z

## Violations par type

### 📂 FILE_TOO_LARGE (4)
- `orchestrator.ts`
  - Valeur: 624 (seuil: 500)
  - 💡 Découpe en modules plus petits. Envisage de séparer les types, les helpers, et la logique principale.
- `server/app.ts`
  - Valeur: 1049 (seuil: 500)
  - 💡 Découpe en modules plus petits. Envisage de séparer les types, les helpers, et la logique principale.
- `agents/scout.ts`
  - Valeur: 604 (seuil: 500)
  - 💡 Découpe en modules plus petits. Envisage de séparer les types, les helpers, et la logique principale.
- `agents/artisan.ts`
  - Valeur: 606 (seuil: 500)
  - 💡 Découpe en modules plus petits. Envisage de séparer les types, les helpers, et la logique principale.

### ⚠️ UNSAFE_ANY (2)
- `orchestrator.ts:196`
  - 💡 Remplace `any` par un type précis ou `unknown` + narrowing.
- `agents/archPolice.ts:190`
  - 💡 Remplace `any` par un type précis ou `unknown` + narrowing.

### 🔍 MISSING_RETURN_TYPE (19)
- `orchestrator.ts:241` — `getLastHotspots`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "getLastHotspots".
- `orchestrator.ts:616` — `diagnostics`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "diagnostics".
- `utils/stripeMock.ts:137` — `buildWebhookEvent`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "buildWebhookEvent".
- `utils/logDigest.ts:108` — `digest`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "digest".
- `utils/cache.ts:172` — `snapshot`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "snapshot".
- `integrations/atlassian.ts:195` — `createXrayTestRun`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "createXrayTestRun".
- `agents/updater.ts:58` — `run`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "run".
- `agents/sentinel.ts:268` — `run`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "run".
- `agents/scout.ts:485` — `run`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "run".
- `agents/qaEngineer.ts:216` — `generateRegressionTest`
  - 💡 Ajoute un type de retour explicite sur la fonction exportée "generateRegressionTest".
  - ...et 9 autres

### 🔄 HIGH_COMPLEXITY (9)
- `utils/stripeMock.ts:159` — `switch`
  - Valeur: 11 (seuil: 10)
  - 💡 Complexité cyclomatique 11 dans "switch". Utilise early-return et table de dispatch.
- `utils/compressor.ts:102` — `tokenise`
  - Valeur: 12 (seuil: 10)
  - 💡 Complexité cyclomatique 12 dans "tokenise". Utilise early-return et table de dispatch.
- `utils/compressor.ts:138` — `buildTree`
  - Valeur: 11 (seuil: 10)
  - 💡 Complexité cyclomatique 11 dans "buildTree". Utilise early-return et table de dispatch.
- `utils/compressor.ts:164` — `purge`
  - Valeur: 13 (seuil: 10)
  - 💡 Complexité cyclomatique 13 dans "purge". Utilise early-return et table de dispatch.
- `server/app.ts:704` — `connect`
  - Valeur: 11 (seuil: 10)
  - 💡 Complexité cyclomatique 11 dans "connect". Utilise early-return et table de dispatch.
- `server/app.ts:797` — `createApp`
  - Valeur: 20 (seuil: 10)
  - 💡 Complexité cyclomatique 20 dans "createApp". Utilise early-return et table de dispatch.
- `agents/scout.ts:88` — `detectStack`
  - Valeur: 16 (seuil: 10)
  - 💡 Complexité cyclomatique 16 dans "detectStack". Utilise early-return et table de dispatch.
- `agents/scout.ts:369` — `fetchGitLog`
  - Valeur: 14 (seuil: 10)
  - 💡 Complexité cyclomatique 14 dans "fetchGitLog". Utilise early-return et table de dispatch.
- `agents/runner.ts:69` — `runTests`
  - Valeur: 21 (seuil: 10)
  - 💡 Complexité cyclomatique 21 dans "runTests". Utilise early-return et table de dispatch.

### 📏 FUNCTION_TOO_LONG (5)
- `utils/report.ts:71` — `writeCliReport`
  - Valeur: 95 (seuil: 80)
  - 💡 Fonction "writeCliReport" (95 lignes). Extrais des sous-fonctions nommées.
- `server/app.ts:742` — `setTimeout`
  - Valeur: 90 (seuil: 80)
  - 💡 Fonction "setTimeout" (90 lignes). Extrais des sous-fonctions nommées.
- `server/app.ts:797` — `createApp`
  - Valeur: 238 (seuil: 80)
  - 💡 Fonction "createApp" (238 lignes). Extrais des sous-fonctions nommées.
- `agents/runner.ts:69` — `runTests`
  - Valeur: 82 (seuil: 80)
  - 💡 Fonction "runTests" (82 lignes). Extrais des sous-fonctions nommées.
- `agents/coverage.ts:83` — `generateCoverageHtml`
  - Valeur: 92 (seuil: 80)
  - 💡 Fonction "generateCoverageHtml" (92 lignes). Extrais des sous-fonctions nommées.

## Plan de refactoring (LLM)

LLM indisponible
