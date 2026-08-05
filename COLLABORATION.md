# Travailler à deux sur ce dépôt

Ce document décrit **comment on s'organise**. La doc technique (installation, architecture)
est dans `CONTRIBUTING.md` et `ARCHITECTURE.md`.

## Le principe

Le dépôt est privé. Deux personnes y travaillent :

- **Julien** — propriétaire du projet. Tranche tout ce qui touche au métier, au droit belge,
  aux comptes tiers (Cloudflare, Stripe, Beds24) et à la mise en production.
- **Son frère** — contributeur. Autonome sur le code, le site public, l'accessibilité,
  le référencement, la performance et le back-office.

La règle qui prime sur toutes les autres : **rien ne part en production sans un « go » explicite
de Julien.** Le merge sur `main` ne déploie rien automatiquement, et c'est voulu.

## Branches

- `main` — toujours verte, toujours déployable. **On n'y pousse pas en direct.**
  Attention : cette règle est tenue à la main. GitHub n'offre la protection de
  branche sur les dépôts privés qu'à partir des plans payants, donc rien ne
  l'empêche techniquement — c'est une discipline, pas un verrou.
- `feat/<sujet-court>` — une fonctionnalité.
- `fix/<sujet-court>` — une correction.
- `chore/<sujet-court>` — outillage, dépendances, doc.

Une branche = une issue = une PR. Si la branche grossit au point de toucher trois zones,
c'est qu'il fallait trois issues.

## Le cycle normal

1. Prendre une issue et se l'assigner (sinon on se marche dessus).
2. Brancher depuis `main` à jour.
3. Coder. `npm run typecheck` et `npm test` doivent rester verts en local.
4. Ouvrir la PR. La CI rejoue typecheck + tests sur chaque PR.
5. Relecture par l'autre frère, puis merge en squash.

Sur les zones sensibles — `migrations/`, `src/services/`, `wrangler.jsonc` — la relecture de
Julien est requise avant merge. Ailleurs, une relecture suffit, quel qu'en soit l'auteur.

## Se répartir le travail

Chaque issue porte un label de zone. C'est la façon la plus simple de ne pas se croiser :

| Zone | Label | Contenu |
|---|---|---|
| Site public | `area:site-public` | Les pages visibles par les voyageurs, hors tunnel de réservation |
| Back-office | `area:back-office` | L'interface de gestion : planning, réservations, tarifs, comptes |
| API et moteur | `area:api-moteur` | Disponibilité, liaison des unités, tarification, paiements |
| Base de données | `area:base-donnees` | Schéma D1 et migrations |
| Infra | `area:infra` | Configuration, CI, déploiement |

Deux personnes peuvent travailler en parallèle sans conflit tant qu'elles sont sur des zones
différentes. `area:api-moteur` et `area:base-donnees` se recoupent souvent — se prévenir avant
d'y toucher à deux.

## Les issues bloquées

Certaines issues portent le label `decision-julien`. Elles décrivent un travail réel, mais qui
attend un arbitrage : un token Cloudflare, l'entité qui encaissera via Stripe, la grille
tarifaire réelle, les CGV, l'adresse de contact. **Ne pas les commencer** — le corps de l'issue
dit précisément quelle décision manque. Julien les débloque par lots.

## Ce qu'on ne met jamais dans le dépôt

- Aucune clé, aucun token, aucun mot de passe. Les secrets vivent dans `.dev.vars` en local
  (ignoré par git) et dans les secrets Cloudflare en ligne. `.dev.vars.example` et `.env.example`
  documentent les variables attendues, avec des valeurs factices.
- Aucune donnée de vrai voyageur : pas de nom, pas d'email, pas de téléphone, pas de montant
  réel, ni dans les fixtures de test, ni dans les migrations de seed. C'est du RGPD, pas une
  préférence de style.
- Aucun export de la base de production.

En cas de doute sur un fichier, on ne le commite pas et on demande.

## Base de données

Une migration ne se modifie jamais après avoir été appliquée quelque part : on en ajoute une
nouvelle. Les migrations sont numérotées et se jouent dans l'ordre. Tester en local
(`npm run db:migrate:local`) avant d'ouvrir la PR.

## Déploiement

Réservé à Julien, sur décision explicite, runbook dans le `README.md`. Un contributeur n'a
pas besoin des identifiants de production pour travailler : tout le développement se fait en
local contre une base D1 locale, avec Stripe en mode simulé et les emails journalisés sans
être envoyés.
