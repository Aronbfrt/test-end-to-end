<p align="center"><img src="docs/assets/logo.png" alt="Test End-to-End" width="640"></p>

<p align="center"><b>C'est la révolution des tests end-to-end.</b></p>

<p align="center">Générateur de tests E2E zéro effort manuel — pytest + Selenium, n'importe quel langage backend, tout découvert depuis le code lui-même.</p>

<p align="center"><img src="docs/assets/demo.gif" alt="Démo terminal" width="560"></p>

---

## Le problème que ça résout

Écrire une suite de tests end-to-end correcte prend des jours : trouver toutes les routes, écrire les sélecteurs, gérer l'auth, penser au SEO, à la sécurité, à l'accessibilité, au responsive — et la maintenir à jour à chaque changement de code. La plupart des projets n'en ont juste pas, ou une poignée de tests qui datent d'il y a six mois.

`test-end-to-end` lit le code du projet (routes, formulaires, entités admin) et génère la suite à la place de l'humain : pytest + Selenium, structurée proprement, avec les checks qualité qui comptent vraiment (pas juste "la page charge"). Une commande, zéro saisie manuelle, et un rapport qui explique chaque échec au lieu de juste dire "assert failed".

## Comment ça marche

1. **Découverte** — analyse statique du code (pas de crawl live) : grep les routes selon le framework détecté (`composer.json` → PHP, `pom.xml` → Spring, `manage.py` → Django, `app/` → Next.js, etc.), extrait les formulaires et leurs champs, repère les entités admin.
2. **Génération** — remplit un template de tests éprouvé (structure validée sur une vraie suite de 300+ tests en prod) avec les vraies routes/sélecteurs trouvés. Jamais de placeholder laissé en plan.
3. **Exécution** — `pytest` + Selenium, navigateurs partagés par rôle (pas un par test) pour scaler à 1000+ tests sans exploser le temps de run.
4. **Rapport** — dashboard custom (pas le tableau pytest-html brut) : groupes par domaine, filtres par catégorie, recherche, chaque échec sécu/SEO explique le risque et le fix, screenshot cliquable en grand, bouton qui relance vraiment le test si le rapport tourne via le petit serveur local inclus.
5. **Idempotent** — relancer `/e2e-audit` plus tard ne réécrit pas ce qui existe déjà ; ça ajoute les nouvelles routes et signale ce qui semble périmé.

## Pour qui

Quiconque utilise Claude Code sur un projet web (peu importe le langage backend) et veut une vraie couverture E2E sans y passer une semaine : développeur solo, petite équipe sans QA dédiée, ou juste pour avoir un garde-fou avant chaque déploiement.

---

## Installation

```
/plugin marketplace add Aronbfrt/test-end-to-end
/plugin install test-end-to-end@test-end-to-end
```

## Commandes

| Commande | Action |
|---|---|
| `/e2e-init` | Setup guidé — copie le template, routes/forms remplis étape par étape |
| `/e2e-audit` | Audit automatique complet — découvre chaque route/form/entité par analyse statique, génère tests basiques + SEO + sécurité + accessibilité + performance + responsive, les lance. Zéro saisie manuelle. Idempotent : un re-run synchronise les nouvelles routes sans toucher aux tests déjà écrits à la main. |

Déclencheurs langage naturel (si mappés dans ton `CLAUDE.md`) : "teste-moi le site", "audit le site", "test complet" → `/e2e-audit`.

---

## Le pipeline

<p align="center"><img src="docs/assets/devops-pipeline.png" alt="Pipeline DevOps" width="900"></p>

---

## Ce que tu obtiens

- **Page Object Model** — sélecteurs dans `tests/pages/`, jamais en dur dans un test
- **Dossiers plats par domaine** — `tests/auth/`, `tests/admin/`, `tests/checkout/`... une feature = un endroit
- **Navigateurs session-scoped** — un navigateur par rôle pour toute la run, scale à 1000+ tests
- **Checks SEO** — title/meta/canonical/h1/alt/structured data/robots/sitemap, chaque échec explique pourquoi ça compte
- **Checks sécurité** — non-destructifs : fuite erreur SQL, échappement input réfléchi, headers sécu, chemins sensibles exposés, bannières debug, bypass auth admin. Jamais destructif, jamais contre la prod.
- **Rapport HTML enrichi** — échecs avec screenshot + erreurs console embarqués direct dans la ligne, thème sombre, colonne Catégorie (sécu = badge rouge 🔒)
- **Zéro install** — `tests/run.sh` installe automatiquement les paquets pip manquants
- **N'importe quelle stack** — PHP, Java/Spring, Next.js, Django, Flask, Rails, Go, Rust, Elixir — la découverte de routes s'adapte selon le fichier marqueur (`composer.json`, `pom.xml`, `manage.py`...)

Voir `templates/e2e/README.md` pour la référence complète de structure une fois installé dans un projet.

---

## Le rapport

<p align="center"><img src="docs/report-screenshot.png" alt="Rapport E2E — thème sombre, colonne Catégorie, screenshots embarqués" width="700"></p>

---

## Contributeurs

- [Aron Beaufort](https://github.com/Aronbfrt) — créateur & mainteneur

PR bienvenues — voir `templates/e2e/README.md` pour les conventions à suivre (Page Object Model, dossiers plats par domaine, messages d'assertion qui expliquent le pourquoi, pas juste le quoi).
