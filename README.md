# Test End-to-End — plugin Claude Code

**C'est la révolution des tests end-to-end.**

Générateur de tests E2E zéro effort manuel. pytest + Selenium, n'importe quel langage backend, tout découvert depuis le code lui-même — aucune route à saisir à la main.

![Démo terminal](docs/assets/demo.gif)

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

## Le pipeline

![Pipeline DevOps](docs/assets/devops-pipeline.png)

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

## Le rapport

![Rapport E2E — thème sombre, colonne Catégorie, screenshots embarqués](docs/report-screenshot.png)

## Contributeurs

- [Aron Beaufort](https://github.com/Aronbfrt) — créateur & mainteneur

PR bienvenues — voir `templates/e2e/README.md` pour les conventions à suivre (Page Object Model, dossiers plats par domaine, messages d'assertion qui expliquent le pourquoi, pas juste le quoi).

---

<p align="center"><img src="docs/assets/logo.png" alt="Test End-to-End" width="420"></p>

## Licence

MIT
