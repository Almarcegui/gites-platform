# Tests — à lire avant de « réparer » la configuration

```bash
npm test                              # toute la suite, ~9 s
npx vitest run test/pricing.test.ts   # un seul fichier
npx vitest run -t "courses"           # par nom de test
npm run test:watch                    # surveillance
```

Aucun serveur à lancer : la suite est autonome.

---

## ⚠️ `@cloudflare/vitest-pool-workers` est inutilisable ici — ce n'est pas un oubli

Son service de fallback de modules ne résout plus rien dès que le chemin du
projet contient un **emoji** — et c'est le cas du dossier de travail du
propriétaire (`🔧 Dev/…`). On obtient alors :

```
ERR_RUNTIME_FAILURE — No such module "node:vm"
```

Vérifié le 2026-07-12 : la même suite est verte depuis un chemin ASCII.

**La parade est déjà en place et fonctionne.** `vitest.config.ts` utilise le
pool Node standard, et les tests qui ont besoin d'une vraie D1 pilotent
**Miniflare directement** (`test/helpers/d1.ts`) — même moteur workerd, même
sémantique SQLite.

Donc : **ne réinstallez pas `vitest-pool-workers`**, ne « corrigez » pas
`vitest.config.ts`. Si vous clonez le dépôt dans un chemin sans emoji chez vous,
tant mieux — mais la configuration doit rester compatible avec la machine du
propriétaire.

---

## Comment la suite est organisée

Deux familles :

- **Tests purs** — `pricing`, `holidays`, `availability`. Aucune base, quelques
  millisecondes. C'est là qu'il faut écrire en premier.
- **Tests sur vraie D1** — `booking-db`, `api`, `lot-a0`, `ical`, `messages`,
  `inbound-email`, `elloha-import`, `beds24-*`. Chacun démarre une base
  **Miniflare en mémoire** avec toutes les migrations rejouées, via
  `createTestDb()` de `helpers/d1.ts`. Isolée par instance, jetée après.

Corollaire utile : **une migration cassée fait tomber toute la suite**, puisque
`createTestDb()` les rejoue toutes. Le découpage des fichiers `.sql` est naïf —
voir [`../migrations/README.md`](../migrations/README.md) avant d'écrire du SQL.

---

## Écrire un test

- Une modification du **moteur de disponibilité** doit être couverte **deux
  fois** : côté TypeScript (`availability.test.ts`) **et** côté SQL
  (`booking-db.test.ts`). Les deux implémentations coexistent volontairement
  (cf. `ARCHITECTURE.md` § 3).
- Une modification du **tunnel de réservation** ou d'un endpoint : `api.test.ts`.
- Un **scénario de panne** (webhook tardif, conflit, saisie aberrante) :
  `lot-a0.test.ts`, le fichier dédié aux cas dégradés.
- **Données de test : toujours inventées.** Jamais de nom, email, téléphone ou
  adresse de vrai voyageur, ni dans un test, ni dans un seed, ni dans une
  fixture.

Le test le plus important du dépôt est celui de course dans `booking-db.test.ts` :
deux clients simultanés sur le même créneau, un seul doit gagner. C'est le seul
endroit du code où une erreur se traduit par un surbooking chez un vrai client.
