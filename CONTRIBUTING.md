# Contribuer au projet

> Ce guide part du principe que tu **ne connais pas le code**. Il te fait passer
> de « je viens de cloner » à « ma première PR est ouverte » sans avoir à poser
> de question.
>
> Avant d'écrire la première ligne de code, lis **`ARCHITECTURE.md`** — surtout
> la section 3 (disponibilité liée + insertion atomique) et la section 5
> (site public vs back-office). Le `README.md` documente les règles métier et
> les procédures de déploiement.

---

## 0. La règle qui prime sur tout le reste

> [!danger]
> **Aucun déploiement en production sans accord explicite du propriétaire.**
>
> Concrètement, les commandes suivantes sont **interdites** sans un « oui » clair
> et explicite du propriétaire, demandé pour cette fois-là :
>
> ```
> wrangler deploy                    # et toute variante
> wrangler deploy --env production
> npm run db:migrate:remote          # migrations sur la base DISTANTE
> wrangler secret put … --env production
> python3 node/deploy-ftp.py         # déploiement Infomaniak
> ```
>
> Ce n'est pas une précaution de principe : la plateforme est reliée à un **compte
> Beds24 réel sans bac à sable**, connecté à Airbnb et Booking. Un déploiement
> malheureux pousse des prix de test jusqu'aux annonces publiques.
>
> **Merger sur `main` ne déclenche aucun déploiement.** La CI ne fait que
> vérifier (`typecheck` + `test`). Le déploiement reste une action manuelle du
> propriétaire, avec le runbook du `README.md`.

Deux autres interdits du même ordre :

- **Ne jamais commiter de secret** (clé Stripe, jeton Beds24, `ADMIN_TOKEN`,
  identifiants FTP). Le `.gitignore` couvre les fichiers concernés — ne le
  contourne pas.
- **Ne jamais commiter de donnée de vrai voyageur** (nom, email, téléphone,
  adresse) dans un test, un seed ou une fixture. Utilise des données inventées.

---

## 1. Prérequis

| Outil | Version | Comment vérifier | Note |
|---|---|---|---|
| **Node.js** | **≥ 22** (obligatoire) | `node --version` | `node:sqlite` est intégré au runtime à partir de la 22 — c'est ce qui évite toute compilation native |
| **npm** | fourni avec Node | `npm --version` | |
| **git** | récent | `git --version` | |

**Wrangler n'est pas à installer globalement.** Il est en `devDependencies` et
s'utilise via `npx wrangler …` ou via les scripts npm. Version épinglée : `^4.114.0`.

### Comptes tiers : lesquels sont vraiment nécessaires ?

**Pour développer en local : aucun.** C'est un choix de conception — sans clé,
chaque intégration bascule en mode dégradé sûr.

| Service | Nécessaire en local ? | Sans lui, il se passe quoi ? |
|---|---|---|
| **Cloudflare** | **Non** | `wrangler dev` tourne entièrement en local (miniflare + SQLite sur disque). Un compte n'est requis que pour déployer — donc pas pour toi. |
| **Stripe** | Non | **Mode stub** : le paiement passe par `/book/dev-pay.html`, une page locale qui simule Stripe et rejoue le chemin du webhook. Le parcours complet est testable. |
| **Resend** (emails) | Non | **Mode stub** : rien n'est envoyé, tout est journalisé dans la table `email_log`, consultable depuis le back-office. |
| **Beds24** (canal OTA) | Non | Intégration **OFF** sans `BEDS24_REFRESH_TOKEN`. Et même avec un jeton, les écritures sont bloquées hors `https` (`beds24WritesAllowed()`). |

Autrement dit : `npm install` puis `npm run dev` suffisent à avoir une plateforme
fonctionnelle avec deux domaines, trois hébergements et un jeu de tarifs.

---

## 2. Installation, pas à pas

```bash
# 1. Cloner
git clone <url-du-repo> gites-platform
cd gites-platform

# 2. Installer les dépendances (5 paquets de dev, rien à l'exécution)
npm install

# 3. Créer le fichier de secrets locaux
cp .dev.vars.example .dev.vars
```

**4. Ouvre `.dev.vars` et renseigne `ADMIN_TOKEN`.** C'est la **seule** variable
obligatoire. En local, n'importe quelle chaîne fait l'affaire :

```
ADMIN_TOKEN=dev:motdepasse-local-quelconque
```

Le format est `identifiant:motdepasse`. Tu te connecteras au back-office avec
`dev` / `motdepasse-local-quelconque`. (Le format historique — un mot de passe nu
sans identifiant — reste accepté.)

> [!warning]
> `ADMIN_TOKEN` **n'est pas optionnel**. La garde de l'API admin est
> *fail-closed* : sans jeton ni compte en base, **toute** route `/api/admin/*`
> répond `503` et le back-office est inutilisable. Ce comportement est
> volontaire (audit sécurité — auparavant, un jeton absent ouvrait tout le
> fichier clients à qui atteignait l'URL).

Les autres clés du fichier restent **vides** : Stripe, Resend et Beds24 basculent
alors en mode stub / désactivé, ce qui est exactement ce qu'on veut en local.

```bash
# 5. Créer la base locale et y appliquer les 12 migrations (+ le seed)
npm run db:migrate:local

# 6. Lancer le serveur de développement
npm run dev -- --port 8788
```

> [!important]
> **Toujours `--port 8788`, jamais le port par défaut.**
> Le **8787** est occupé en permanence sur la machine du propriétaire par un
> autre service (LaunchAgent Legal Ops). Le `PUBLIC_BASE_URL` de `wrangler.jsonc`
> est d'ailleurs calé sur `http://localhost:8788` : lancer sur un autre port
> fabriquerait des liens de paiement et des URLs de voucher pointant dans le vide.

### Ce que tu dois voir

| URL | Attendu |
|---|---|
| http://localhost:8788/ | Le site vitrine (Les Gîtes du Pré Moré) |
| http://localhost:8788/book/ | La landing des domaines, puis le tunnel |
| http://localhost:8788/admin/ | Le back-office (redirige vers `login.html`) |
| http://localhost:8788/api/public/properties | Un JSON avec 2 domaines |

Vérification rapide en une commande :

```bash
curl -s http://localhost:8788/api/public/properties
# → {"properties":[{"slug":"pre-more",…},{"slug":"moulin-braives",…}]}
```

### 7. Première connexion au back-office

Sur une base fraîche, la table `admin_users` est **vide**. C'est donc le secret
`ADMIN_TOKEN` qui ouvre la porte :

1. Va sur http://localhost:8788/admin/ → tu es redirigé vers `login.html`.
2. Saisis l'identifiant et le mot de passe de ton `ADMIN_TOKEN`
   (`dev` / `motdepasse-local-quelconque` dans l'exemple ci-dessus).
3. Tu es dans le back-office. Le navigateur garde ces identifiants dans
   `localStorage` (`gp_user`, `gp_token`).

**Pour créer un vrai compte** (le mode normal), va dans **`#/users` — Utilisateurs**,
clique « Ajouter » et saisis un identifiant. Le **mot de passe est généré par le
serveur** au format `mot-mot-mot-NN` (dictable au téléphone) et **affiché une
seule fois** — copie-le tout de suite. La connexion suivante ouvrira alors une
vraie session de 30 jours (`Authorization: Bearer session:<jeton>`), et seul le
SHA-256 du jeton sera stocké en base.

### 8. Vérifier que tout va bien

```bash
npm test        # 152 tests, ~9 s
npm run typecheck
```

Si ces deux commandes sont vertes, ton environnement est bon.

---

## 3. Les variables d'environnement, fichier par fichier

Il y a **trois** fichiers d'exemple, pour **trois usages différents**. Ne les confonds pas.

### `.dev.vars.example` → `.dev.vars` — **le seul dont tu as besoin**

Développement local avec `wrangler dev`. **Gitignoré.**

| Variable | Obligatoire ? | Rôle |
|---|---|---|
| `ADMIN_TOKEN` | **Oui** | Accès au back-office. Format `user:motdepasse`, plusieurs paires séparées par des virgules. |
| `STRIPE_SECRET_KEY` | Non | **`sk_test_…` uniquement.** Vide → mode stub (`/book/dev-pay.html`). |
| `STRIPE_WEBHOOK_SECRET` | Non | Vérification HMAC du webhook. |
| `RESEND_API_KEY` / `RESEND_FROM` | Non | Emails sortants. Vide → journalisation seule. |
| `BEDS24_REFRESH_TOKEN` | Non | Canal OTA. Vide → intégration OFF. |
| `BEDS24_WEBHOOK_KEY` | Non | Clé du webhook entrant Beds24. |

Les variables **non secrètes** (`PUBLIC_BASE_URL`, `EMAILS_ENABLED`) sont dans
`wrangler.jsonc`, pas ici.

> [!caution]
> **Si un jour tu ajoutes une vraie clé Stripe en local : `sk_test_` uniquement.**
> L'entité juridique qui encaisse n'est pas encore tranchée, et une clé `sk_live_`
> ferait passer de vrais paiements.

### `.env.example` → `.env` — déploiement Node/Infomaniak **seulement**

Ne sert **pas** en développement local. Il concerne la cible d'hébergement
alternative (`node/server.mjs` + SQLite). Variables obligatoires de ce côté :
`PUBLIC_BASE_URL`, `SQLITE_PATH`, `ADMIN_TOKEN`, `CRON_KEY`.
Ce fichier se crée **directement sur le serveur**, jamais téléversé depuis le dépôt.

### `.deploy.vars.example` → `.deploy.vars` — identifiants FTP **seulement**

Utilisé uniquement par `node/deploy-ftp.py`. Tu n'y touches pas.

### Ce qui n'est jamais commité

Le `.gitignore` est écrit en **globs**, pas en noms exacts — pour qu'un
`.dev.vars.backup` ou un `.env.prod` créé à la volée soit couvert lui aussi.
Trois blocs :

- **Secrets** : `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`, `.deploy.vars`,
  `.deploy.vars.*`, `.secrets*`, `*.pem`, `*.key`, `*.p12`, `*.pfx` — avec les
  exceptions `!*.example` pour que les gabarits restent versionnés ;
- **Bases et sauvegardes (RGPD — données voyageurs)** : `data/`, `sauvegardes/`,
  `backups/`, `*.db*`, `*.sqlite*`, `*.sql.gz`, `*.dump` ;
- **Artefacts** : `node_modules/`, `.wrangler/`, `dist/`, `_scratch/`, `*.log`, `.DS_Store`.

> [!danger]
> **Ne retire jamais une de ces lignes**, et surtout **n'ajoute jamais `*.sql`
> tout court** : cela exclurait `migrations/` et ferait disparaître tout le
> schéma du dépôt. Les sauvegardes sont déjà couvertes par `sauvegardes/`,
> `*.sql.gz` et `*.dump`.
>
> Rappel de fonctionnement : **le `.gitignore` ne s'applique pas aux fichiers
> déjà suivis.** Si un fichier sensible a été committé une fois, l'ajouter au
> `.gitignore` ne le retire pas — il faut un `git rm --cached`.

---

## 4. Les commandes du quotidien

| Commande | Ce qu'elle fait |
|---|---|
| `npm run dev -- --port 8788` | Serveur de développement (Worker + assets + D1 locale) |
| `npm test` | Toute la suite — 152 tests, ~9 s |
| `npm run test:watch` | Vitest en mode surveillance |
| `npm run typecheck` | `tsc --noEmit` — strict, aucune erreur tolérée |
| `npm run db:migrate:local` | Applique les migrations en attente sur la base locale |
| `npm run db:reset:local` | **Détruit** `.wrangler/state` et repart d'une base neuve |
| `npm run build` | Compile vers `dist/` (uniquement pour la cible Node) |

> [!tip]
> `npm run db:reset:local` est ton meilleur ami quand la base locale part en
> vrille. Elle est jetable — le seed la reconstruit complètement.

---

## 5. Lancer les tests

```bash
npm test                                  # tout
npx vitest run test/pricing.test.ts       # un seul fichier
npx vitest run -t "courses"               # par nom de test
npm run test:watch                        # surveillance
```

> [!important]
> Le détail — organisation de la suite, piège `vitest-pool-workers`, règles
> d'écriture d'un test — vit dans **[`test/README.md`](test/README.md)**,
> c'est-à-dire dans le dossier concerné.

### Comment la suite est organisée

12 fichiers dans `test/`, deux familles :

- **Tests purs** (`pricing`, `holidays`, `availability`) — aucune base, quelques
  millisecondes. C'est là qu'il faut écrire en premier.
- **Tests sur vraie D1** (`booking-db`, `api`, `lot-a0`, `ical`, `messages`,
  `inbound-email`, `elloha-import`, `beds24-*`) — chacun démarre une base
  **Miniflare en mémoire** avec toutes les migrations rejouées, via
  `createTestDb()` de `test/helpers/d1.ts`. Isolée par instance, jetée après.

### Le piège à connaître avant de « réparer » quoi que ce soit

> [!warning]
> **`@cloudflare/vitest-pool-workers` est inutilisable sur ce projet** et ce n'est
> pas un oubli de configuration.
>
> Son service de fallback de modules ne résout plus rien dès que le chemin du
> projet contient un emoji (le dossier vit sous `🔧 Dev/…`) : on obtient
> `ERR_RUNTIME_FAILURE — No such module "node:vm"`. Vérifié le 2026-07-12 : la
> même suite est verte depuis un chemin ASCII.
>
> **La parade est déjà en place et fonctionne** : `vitest.config.ts` utilise le
> pool Node standard, et les tests qui ont besoin d'une vraie D1 pilotent
> **Miniflare directement** (`test/helpers/d1.ts`). Même moteur workerd, même
> sémantique SQLite.
>
> Donc : **ne réinstalle pas `vitest-pool-workers`**, ne « corrige » pas
> `vitest.config.ts`. Si tu clones le dépôt dans un chemin sans emoji chez toi,
> tant mieux — mais la config doit rester compatible avec la machine du
> propriétaire.

### Écrire un test

- Une modification du **moteur de disponibilité** doit être couverte **deux fois** :
  côté TypeScript (`test/availability.test.ts`) **et** côté SQL
  (`test/booking-db.test.ts`). Les deux implémentations coexistent volontairement
  (cf. `ARCHITECTURE.md` §3).
- Une modification du **tunnel de réservation** ou d'un endpoint : `test/api.test.ts`.
- Un **scénario de panne** (webhook tardif, conflit, saisie aberrante) :
  `test/lot-a0.test.ts` — c'est le fichier dédié aux cas dégradés.
- Données de test : **toujours inventées**, jamais de vrai voyageur.

---

## 6. Ajouter une migration de base

> [!important]
> Cette section est le résumé. Le détail — règle des littéraux, ordre
> d'application, conventions du schéma, inventaire des migrations — vit dans
> **[`migrations/README.md`](migrations/README.md)**, c'est-à-dire dans le
> dossier que tu es sur le point d'ouvrir.

1. Crée `migrations/00NN_nom_en_snake_case.sql` — la numérotation continue la
   série (`0013_…`), l'ordre d'application est l'ordre alphabétique du nom.
2. Écris le SQL. **Une migration est à sens unique — il n'y a aucun script de
   rollback dans ce projet.**

> [!danger]
> **Une migration ne se modifie jamais après avoir été appliquée quelque part.**
> Même pour corriger une faute de frappe : les bases qui l'ont déjà jouée ne la
> rejoueront pas, et le schéma diverge silencieusement entre les machines.
> On en ajoute une nouvelle, toujours.
3. Applique en local : `npm run db:migrate:local`.
4. Lance `npm test` : le helper de tests **rejoue toutes les migrations** sur une
   base neuve, donc une migration cassée fait tomber toute la suite immédiatement.

> [!danger]
> **Jamais de `;` ni de `--` à l'intérieur d'un littéral SQL.**
>
> Le découpage des fichiers de migration est volontairement naïf : il retire les
> `--` en fin de ligne, puis fait un `split(";")`. Il est implémenté **deux fois**
> (`test/helpers/d1.ts` et `node/migrate.mjs`). Un point-virgule dans une chaîne
> de caractères casse la migration **silencieusement**.
>
> Corollaire : les apostrophes s'échappent en `''`, et si un commentaire doit
> décrire ce piège, il s'écrit sans double tiret (c'est ce que fait la migration
> 0011).

Autres conventions du schéma, à respecter :

- **Montants en centimes entiers**, jamais de flottant.
- **Dates en TEXT `'YYYY-MM-DD'`** ; `checkout` est **exclusif**.
- **Horodatages** via le défaut `(datetime('now'))`.
- **Booléens en INTEGER 0/1** avec `NOT NULL DEFAULT`.
- **Ids explicites dans les seeds**, pour que les migrations suivantes puissent
  faire un `UPDATE … WHERE id = N` fiable.
- **Jamais de `DELETE`** sur une donnée métier : `active = 0` ou changement de statut.
- L'en-tête de chaque migration porte **la décision et la date** qui la motivent.

---

## 7. Ajouter un endpoint

1. **Choisis le bon fichier.** Route publique (sans auth) → `src/api/public.ts`.
   Route de back-office → `src/api/admin.ts`, et **elle doit être enveloppée dans
   `guard(…)`** comme toutes ses voisines. La seule exception légitime est
   `POST /api/admin/login`.
2. **Toute la logique métier pure** (calcul, règle, transformation) va dans
   `src/core/` — sans I/O, donc testable en millisecondes.
3. **Tout le SQL** va dans `src/db/repo.ts`. N'écris pas de requête ailleurs.
4. Valide strictement les entrées côté public : c'est une surface non authentifiée.
5. Ajoute un test dans `test/api.test.ts`.

---

## 8. Branches et commits

> [!note]
> L'organisation du travail à deux (répartition, labels de zone, issues bloquées
> par une décision) est décrite dans **`.github/COLLABORATION.md`**. Cette
> section n'en donne que la mécanique git.

### Branches

`main` est la branche de référence : **elle doit toujours être verte**
(`typecheck` + `test`) et toujours déployable. On n'y pousse jamais directement —
tout passe par une PR.

Nommage : `<type>/<sujet-court-en-kebab>`

| Préfixe | Pour quoi |
|---|---|
| `feat/` | Nouvelle fonctionnalité |
| `fix/` | Correction de bug |
| `chore/` | Outillage, dépendances, documentation |

```
feat/filtre-canal-reservations
fix/calendrier-mobile-safari
chore/guide-architecture
```

À deux contributeurs, si vous risquez de travailler sur le même sujet, ajoutez
vos initiales : `feat/mp-filtre-canal-reservations`.

**Une branche = une issue = une PR.** Si la branche grossit au point de toucher
trois zones, c'est qu'il fallait trois issues.

### Commits

Format court, en français, à l'impératif :

```
<type>(<zone>): <ce que ça fait>
```

Zones, alignées sur le gabarit de PR : `public`, `admin`, `api`, `db`, `infra`.

```
feat(admin): ajoute le filtre par canal dans Réservations
fix(public): corrige la sélection de départ sur un jour complet
refactor(api): extrait la validation de séjour dans parseStay
chore(db): migration 0013 — index sur messages.booking_id
docs: guide d'architecture et de contribution
```

Le corps du message sert au **pourquoi**, pas au **comment** (le diff dit déjà le
comment). Si une décision du propriétaire est à l'origine du changement, cite-la
avec sa date — c'est la convention déjà suivie dans les en-têtes de migrations.

---

## 9. Ouvrir une pull request

Avant de pousser :

```bash
npm run typecheck
npm test
npm run dev -- --port 8788   # et vérifie dans le navigateur
```

Le gabarit de PR (`.github/pull_request_template.md`) se remplit tout seul à
l'ouverture. Il demande : ce que fait la PR, la **zone touchée** (site public /
back-office / API / base / infra), les vérifications faites, et s'il y a une
migration.

### La CI

`.github/workflows/ci.yml` tourne sur chaque push vers `main` et sur chaque PR :

1. `npm ci` (Node 22)
2. `npm run typecheck`
3. `npm test`

**La CI ne déploie rien.** Elle vérifie, c'est tout.

### La revue et le merge

À deux, la revue est mutuelle : l'autre relit avant merge, puis **merge en squash**.

Deux règles s'ajoutent :

- **Zones sensibles — la relecture du propriétaire est requise** avant merge :
  `migrations/`, `src/services/`, `wrangler.jsonc`. Ailleurs, une relecture
  suffit, quel qu'en soit l'auteur.
- **Point d'attention systématique** : si la PR touche à la disponibilité, aux
  liaisons entre unités ou à la création de réservation, relire spécifiquement
  l'INSERT atomique (`ARCHITECTURE.md` §3). C'est le seul endroit du code où une
  erreur se traduit par un surbooking chez un vrai client.

### Signaler un problème

Deux gabarits d'issue existent : **Bug** (`type:bug`) et **Tâche** (`type:tache`).
Utilise-les — ils demandent déjà la zone concernée et l'unité impactée.

Chaque issue porte en plus un **label de zone**, qui sert à ne pas se marcher
dessus : `area:site-public`, `area:back-office`, `area:api-moteur`,
`area:base-donnees`, `area:infra`. Deux personnes peuvent travailler en parallèle
sans conflit tant qu'elles sont sur des zones différentes — `area:api-moteur` et
`area:base-donnees` se recoupent souvent, se prévenir avant d'y toucher à deux.

> [!warning]
> Les issues portant le label **`decision-julien`** décrivent un travail réel mais
> **en attente d'un arbitrage du propriétaire** (jeton Cloudflare, entité qui
> encaisse via Stripe, grille tarifaire réelle, CGV, adresse de contact).
> **Ne les commence pas** — le corps de l'issue dit quelle décision manque.

---

## 10. Dépannage

| Symptôme | Cause | Solution |
|---|---|---|
| `Address already in use (127.0.0.1:8788)` | Un `wrangler dev` tourne déjà | `lsof -nP -iTCP:8788 -sTCP:LISTEN` pour trouver le PID. **Vérifie que ce n'est pas la session du propriétaire** avant de tuer quoi que ce soit. |
| `/api/admin/*` répond **503** | `ADMIN_TOKEN` absent de `.dev.vars` | Renseigne-le, redémarre `wrangler dev` (le fichier est lu au démarrage) |
| `/api/admin/*` répond **401** | Identifiants faux, ou session expirée | Reconnecte-toi via `/admin/login.html` |
| **500** sur des routes qui marchaient | Une migration a été ajoutée et n'est pas appliquée en local | `npm run db:migrate:local` — **à refaire après chaque `git pull`** |
| Le back-office ne connaît pas la page Utilisateurs | Migration `0012` non appliquée | Idem |
| Base locale incohérente | État accumulé | `npm run db:reset:local` |
| `internal error; reference = …` sur Stripe/Beds24 en local | VPN d'entreprise : `workerd` lit `/etc/resolv.conf` et les résolveurs `100.64.x` renvoient des réponses vides | Coupe le VPN, ou teste l'intégration en direct (`curl`, script Node). `dig @100.64.0.1 api.beds24.com` le confirme. **En production, le problème n'existe pas.** |
| `ERR_RUNTIME_FAILURE — No such module "node:vm"` | Quelqu'un a réinstallé `vitest-pool-workers` | Reviens au pool Node (cf. §5) |
| Le tunnel affiche « Version de démonstration » | Normal : aucune clé Stripe configurée (`demo: !stripeEnabled(env)`) | Rien à faire en local |

---

## 11. Aide-mémoire

```bash
git clone <url> && cd gites-platform
npm install
cp .dev.vars.example .dev.vars    # puis renseigner ADMIN_TOKEN
npm run db:migrate:local
npm run dev -- --port 8788        # ⚠️ jamais 8787

# après chaque git pull
npm run db:migrate:local

# avant chaque push
npm run typecheck && npm test
```

| | |
|---|---|
| Site public | http://localhost:8788/ |
| Réservation | http://localhost:8788/book/ |
| Back-office | http://localhost:8788/admin/ |
| Architecture du code | `ARCHITECTURE.md` |
| Règles métier, décisions, runbooks | `README.md` |

> [!danger]
> Et pour finir, la seule règle qu'il ne faut jamais oublier :
> **aucun déploiement en production sans accord explicite du propriétaire.**

---

*Guide rédigé le 2026-08-05. Parcours d'installation vérifié de bout en bout sur
une base neuve (migrations appliquées, serveur démarré, endpoints publics et
garde admin testés), `npm test` (152 verts) et `npm run typecheck` exécutés.*
