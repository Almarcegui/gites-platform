## Ce que fait cette PR

<!-- En 2-3 phrases. Le « pourquoi » avant le « comment ». -->

## Zone touchée

- [ ] Site public (`public/` hors `admin/`)
- [ ] Back-office (`app/`, servi sous `/admin/`, et `src/api/admin.ts`)
- [ ] API / moteur métier (`src/`)
- [ ] Base de données (`migrations/`)
- [ ] Infra / config (`wrangler.jsonc`, CI)

## Vérifications

- [ ] `npm run typecheck` passe
- [ ] `npm test` passe
- [ ] Testé en local (`npm run dev -- --port 8788`)
- [ ] Aucun secret, aucune clé, aucune donnée de vrai voyageur ajoutée

## Migration de base

- [ ] Aucune
- [ ] Nouvelle migration ajoutée dans `migrations/` (numérotée, testée en local)

> [!warning]
> Aucun déploiement en production sans accord explicite du propriétaire.
> Le merge sur `main` ne déclenche pas de déploiement automatique.
