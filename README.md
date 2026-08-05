# Gites Platform — plateforme de gestion locative propriétaire

Réservation directe + paiement en ligne + tarification fine + statistiques pour
**Les Gîtes du Pré Moré** (Redu) et, en phase 2, **Le Moulin de Braives** —
en remplacement d'elloha (~857 €/an).

Contexte, décisions et roadmap : `🏠 Privé/Plateforme Gestion Gîtes/`
(00 – Memory + Plan v1 + Wireframe v1).

## Le cœur : le moteur de disponibilité lié

Le point où tous les concurrents sauf Beds24 échouent : les deux maisons du
Pré Moré se louent **seules ou ensemble** (« Domaine entier »).

- Résa Maison du Scieur **ou** La Scierie → le Domaine entier se bloque instantanément.
- Résa Domaine entier → les deux maisons se bloquent.
- Modèle générique : table `unit_links` (`unit_id` bloque `blocks_unit_id`) —
  n'importe quelles unités futures peuvent être liées.
- **Aucun surbooking possible** : la disponibilité est re-vérifiée et la résa
  insérée dans **une seule instruction SQL atomique**
  (`createBookingAtomic`, `src/db/repo.ts`) — prouvé par les tests de course
  (`test/booking-db.test.ts` : 2 clients simultanés → un seul gagnant).
- Les nuitées sont l'intervalle **semi-ouvert** [arrivée, départ) : départ et
  arrivée le même jour compatibles.

## Stack

| Couche | Choix |
|---|---|
| Runtime | Cloudflare Workers (TypeScript strict, zéro dépendance runtime) |
| Base | Cloudflare D1 (SQLite) — migrations dans `migrations/` |
| Front | HTML/CSS/JS vanilla servis en assets (`public/admin/`, `public/book/`) |
| Paiement | Stripe Checkout par API REST — **mode TEST uniquement** tant que l'entité n'est pas tranchée ; **mode stub** intégré sans clé |
| Emails | Resend — **mode stub par défaut** : tout est journalisé dans `email_log`, rien ne part sans `EMAILS_ENABLED=true` + accord Julien |
| OTA | iCal export par unité + import cron 15 min (Airbnb Moulin, phase 3) |
| Tests | Vitest (pool Node) + **Miniflare direct** pour la vraie D1 |

⚠️ `@cloudflare/vitest-pool-workers` est inutilisable ici : son service de
fallback de modules casse sous les chemins emoji du vault (`🔧 Dev/…`).
D'où Miniflare piloté en direct (`test/helpers/d1.ts`) — même moteur workerd,
et ça fonctionne. (Vérifié le 2026-07-12, suite identique verte en chemin ASCII.)

## Démarrage local

```bash
npm install
npm run db:migrate:local     # crée la base locale + seed Pré Moré
npm run dev -- --port 8788   # ⚠️ 8787 = surcouche Legal Ops
npm test                     # 146 tests (moteurs, D1, courses, API, iCal, import, LOT A0)
npm run typecheck
```

- Back-office : http://localhost:8788/admin/
- Page publique : http://localhost:8788/book/
- Sans clé Stripe : le paiement passe par `/book/dev-pay.html` (simulateur local).
- Secrets locaux : copier `.dev.vars.example` → `.dev.vars`. **`ADMIN_TOKEN` y est
  désormais obligatoire** (garde fail-closed) — n'importe quelle chaîne fait
  l'affaire en local, à saisir une fois dans `/admin/` (gardée en localStorage).
- Phase 2 : `npm run db:seed:moulin` (après avoir complété `seed/seed_moulin_braives.sql`).

## Arborescence

```
migrations/            0001 schéma · 0002 seed Pré Moré · 0003 ménage+photos+
                       données réelles · 0004 Moulin de Braives
src/core/              moteurs PURS : dates, fériés BE (computus de Gauss + ponts),
                       disponibilité liée, tarification (+ rateCalendar/jour), stats
src/db/repo.ts         toute la couche D1, dont l'INSERT atomique anti-course
src/services/          stripe, email (stub), ical (export/parse/sync), cron,
                       booking-flow (checkout/webhook/voucher), elloha-import
src/api/               router maison + routes publiques + routes admin
public/admin/          back-office (11 vues + calendrier tarifs + multi-biens)
public/book/           landing domaines + réservation 4 étapes + voucher + dev-pay
test/                  7 fichiers, 99 tests
```

## Nouveautés v2 (2026-07-12 soir — retours Julien)

- **Tarifs & saisons en calendrier par bien** (modèle elloha) : prix calculé jour
  par jour (badge « férié », liseré weekend, teinte par saison, min nuits),
  sélection d'une plage sur le calendrier → création d'une période tarifaire
  (option « tous les biens »). Les périodes/règles restent éditables en tableau dessous.
- **Frais de ménage par bien** (relevés du site réel : Scieur 120 €, Scierie 90 €) :
  ligne automatique du devis, jamais remisée ; un combiné en mode « somme »
  cumule les ménages de ses composantes (Domaine = 210 €).
- **Multi-biens** : sélecteur « Tous » (tableau de bord = cartes de tous les biens
  avec photo + prochaine résa/blocage ; plannings empilés par domaine), le
  **Moulin de Braives** est chargé (contenu réel du site, tarifs TODO), et
  Paramètres permet de **créer un bien** (maison C) avec **liaisons mutuelles**
  posées à la volée — la liaison joue immédiatement (testé).
- **Page publique pro** : landing des domaines, **calendrier de disponibilités
  avec prix « dès X € » par jour** (arrivée puis départ au clic, jours complets
  et passés distincts), photos réelles, parcours en 4 étapes affichées, **bloc
  « Paiement sécurisé Stripe »** explicite (acompte/totalité, Bancontact, option 30 min).
- **Tunnel « ~4 clics » (Lot 2, 2026-07-27)** : recherche lancée automatiquement
  dès que arrivée + départ sont choisis (plus de bouton), **auto-sélection** de
  l'unité quand une seule est réservable ou qu'un deep-link `?unit=` la désigne,
  formulaire réduit à 4 champs (prénom/nom/email/tél — promo et message repliés),
  devis **recalculé automatiquement**, récap sticky desktop + **barre fixe mobile**
  (total + payer), compte à rebours du hold sur le paiement simulé, page
  d'interruption avec **reprise du paiement** (`POST /api/public/bookings/:ref/pay`,
  bouton « Finaliser » sur le voucher pending). **Deep-links**
  `?checkin=&checkout=&adults=&children=&unit=` + reprise de sélection 30 j
  (localStorage) ; le site vitrine envoie ses dates par ces liens (calendrier
  vitrine sélectionnable, CTA dynamique « Réserver du X au Y »).
- **Preuves légales au checkout (Lot 1/2)** : acceptation CGV obligatoire côté
  API (`cgvAccepted`), tracée sur la résa en **version hashée du texte affiché
  (sha256 serveur) + horodatage serveur + IP** (migration 0008) ; texte intégral
  des CGV consultable dans le flux (`cgvText` exposé sur la fiche domaine) ;
  mention explicite « pas de droit de rétractation (art. VI.53, 12° CDE) » sous
  le bouton ; **opt-in marketing non pré-coché** stocké avec horodatage sur le
  client (jamais rétrogradé par une résa suivante).
- Données réelles intégrées : adresses, accroches ; la grille « location » du
  site est **sur demande** → les prix de nuit restent des placeholders TODO_TARIFS.
- **Régime « pas de services » (décisions Julien 27/07, risque de requalification
  TVA para-hôtelière)** : draps et taies **inclus de base** dans les « Frais
  généraux — ménage, draps et charges » (plus jamais en option payante — les
  options draps et l'option « Ménage » doublon sont désactivées, migration 0009) ;
  sauna et bain chaud restent réservables via un bouton **« + Ajouter »**
  (mise à disposition d'équipement, carte « Équipements du séjour ») ; **aucune
  taxe de séjour pour le moment** (0 → la ligne disparaît du devis) ; **arrivée
  18:00, départ 18:00** (rotation le jour même, intervalles semi-ouverts).
- **Photos servies en local** (`public/img/`, migration 0009 pour les
  `photo_url`) : le WordPress ne sert plus les images aux navigateurs
  (échec de chargement constaté, curl OK — problème TLS côté WP) ; 13 images
  rapatriées et compressées (~5,7 Mo, hero 1920 px, cartes 1400 px).

## Règles métier implémentées (défauts à valider avec Julien)

- **Devis par nuit** : saison (priorité la plus haute, sinon tarif de base) →
  prix semaine / weekend (nuits ven+sam) → majoration % automatique sur nuits
  fériées BE, veilles et ponts (fériés **calculés**, Pâques incluse).
- **Min. nuits** : règle de la nuit d'arrivée ; composite « somme » = la plus
  exigeante des composantes.
- **Remises auto** : la MEILLEURE seule (long séjour / early bird / last
  minute) ; un code promo s'ajoute ensuite. Sur l'hébergement uniquement.
- **Prix du Domaine entier** : mode `sum` (somme des deux maisons, défaut) ou
  `own` (grille propre) — réglable dans Paramètres (TODO_PRIX_COMBINE).
- **Acompte** : 30 % à la résa, solde à J-30 ; à moins de 30 j → paiement
  total. Option de paiement (hold) : 30 min, expirée = créneau libéré tout seul.
- **Annulation** : libère le créneau immédiatement ; remboursement éventuel
  manuel dans Stripe (politique d'annulation : TODO Julien).
- **Taxe de séjour** : €/pers/nuit paramétrable — **0 pour le moment**
  (décision Julien 27/07), la ligne du devis se masque toute seule.
- **Fuseau** : toute la logique « aujourd'hui » est en Europe/Brussels ;
  montants en centimes (entiers), arrondi au centime par ligne.

## Beds24 (canal OTA — API v2, branché le 2026-07-28)

Compte Beds24 créé par Julien (essai 14 j) et relié à la plateforme : invite code
généré (UI > Marketplace > API, scopes **read/write sans delete** : bookings,
bookings-personal, bookings-financial:read, inventory, properties, accounts:read,
channels — nom `gites-platform`), échangé contre un **refresh token stocké dans
`.dev.vars`** (`BEDS24_REFRESH_TOKEN`, gitignored ; en prod → `wrangler secret put`).
Service `src/services/beds24.ts` (token 24 h auto-renouvelé, cache 20 h) +
diagnostic `GET /api/admin/beds24/status` (détails compte + propriétés + sondes
réseau en cas d'échec). Auth validée en direct : `GET /properties` → 200.
Révocation : écran Refresh Tokens de l'UI Beds24.

⚠️ **Piège dev local + VPN Emeria** : workerd (wrangler dev) lit `/etc/resolv.conf`
(résolveurs VPN 100.64.0.x) qui renvoie des réponses **vides** pour les domaines
publics → TOUS les fetch sortants du Worker local échouent en
`internal error; reference = …` (les sondes le montrent), alors que curl/navigateur
passent par le résolveur macOS et fonctionnent. Conséquences : tester les
intégrations sortantes en direct (script Node/Python) ou VPN coupé ; **en prod
Cloudflare le problème n'existe pas**. (Vérifié le 2026-07-28 : dig @100.64.0.1
api.beds24.com → NOERROR, answer vide ; wrangler 4.35 → 4.114 n'y change rien —
mise à jour conservée, 122 tests verts.)

**2026-07-28 (GO Julien) — la liaison est EN PLACE et démontrée** :
- Propriété **#344555 « Les Gîtes du Pré Moré »** + rooms **#711713 (Scieur)** et
  **#711714 (Scierie)** créées par API (le Domaine entier reste direct-only : sa
  liaison est déjà reflétée dans les calendriers des deux rooms).
- **Mapping D1** : migration 0010 (`properties.beds24_property_id`,
  `units.beds24_room_id`).
- **Synchro sortante** `src/services/beds24-sync.ts` : dispo (isUnitFree — liaison
  comprise) + prix (rateCalendar, en euros) + min-nuits, jours regroupés en plages
  compactes ; POST `/inventory/rooms/calendar`. Accrochée au **cron 15 min**
  (étape 4, inactive sans token) + push manuel `POST /api/admin/beds24/push`.
- **Pont dev local** `scripts/beds24_push_calendar.py` (le Worker local ne sort
  pas sous VPN) : 12 mois poussés — vérifié dans l'UI Beds24 (calendrier :
  240/280 € Scieur, 160/180 € Scierie, 322/207 € le 15 août, min-stay 7 puis 2,
  jours réservés chez nous → inventory 0). 124 tests verts (dont : résa Domaine
  → les 2 rooms Beds24 fermées).

**2026-07-28 (soir) — pilotage 100 % depuis notre back-office (« ne jamais ouvrir
Beds24 », demande Julien)** :
- **Vue « Canaux OTA »** (`#/canaux`) : état de la liaison (badge, propriété
  #344555, dernier rapatriement), boutons Tester / **Rapatrier les résas** /
  **Pousser les calendriers**, correspondance des hébergements (Domaine = vente
  directe, liaison automatique), tableau des résas venues des canaux, journal de
  synchronisation (audit `beds24.*`).
- **Synchro ENTRANTE** (`applyChannelBookings` + `pullBeds24Bookings`) : les
  résas des canaux descendent chez nous — création avec client complet
  (nom/email/tél via upsertGuest), montant, label canal (Airbnb, Booking.com…),
  `external_uid = beds24:<id>`, `source = 'ical'` (résa de canal synchronisé —
  choix assumé, pas de refonte du CHECK) ; déplacements appliqués atomiquement,
  annulations canal → libération, **conflits refusés et signalés** (nos dates
  priment) ; curseur incrémental `beds24_last_pull` (settings, marge 10 min).
- **Cron 15 min étape 4 = pull PUIS push** (l'état poussé intègre les résas qui
  viennent d'arriver). Routes admin : POST `/api/admin/beds24/pull`, GET
  `/api/admin/channels/overview` (état local instantané, zéro réseau sortant).
- **129 tests verts** (synchro entrante : import riche + idempotence,
  déplacement, annulation, conflit, room inconnue/dates invalides).

**2026-07-28 (nuit) — synchro TEMPS RÉEL (retour Julien : « pas toutes les x
minutes »)** :
- **Sortant événementiel** : `triggerBeds24Push` (waitUntil — zéro latence
  ajoutée à la réponse ; await inline dans les tests) appelé à chaque mutation :
  résa publique (hold posé), vente manuelle, annulation admin, saisons et règles
  tarifaires (create/update/delete → `triggerBeds24PushAll`) ; le bouton
  « Rapatrier » enchaîne aussi un push. Le routeur transmet désormais
  l'ExecutionContext aux handlers (5ᵉ argument optionnel, rétro-compatible).
- **Entrant événementiel** : webhook `POST /api/webhooks/beds24?key=…`
  (BEDS24_WEBHOOK_KEY, clé générée en .dev.vars) — la notification est un
  signal, la vérité vient d'un pull immédiat + push enchaîné (waitUntil,
  réponse instantanée à Beds24). URL complète affichée dans la vue Canaux
  (bouton Copier) — à coller dans Beds24 au déploiement.
- **Le cron 15 min devient un simple filet de sécurité** (holds expirés,
  échecs réseau, webhooks perdus).
- **130 tests verts** — dont un test de câblage bout en bout : POST
  /api/public/bookings avec fetch stubé → un POST /inventory/rooms/calendar
  part vers Beds24 dans la même requête.
- Latence résiduelle réelle = la propagation Beds24 ↔ OTAs (connexions
  certifiées, quelques secondes à minutes), plus rien chez nous.

Reste au LOT 4/5 : créer les annonces OTA à la main (Airbnb/Booking — les avis
restent attachés), les mapper aux rooms dans Beds24 (assistance Claude via la
session Chrome), et coller l'URL du webhook dans Beds24 au déploiement.

## Synchro iCal (phase 3 — Airbnb Moulin)

- Export : `GET /ical/<token>.ics` par unité (token secret, régénérer au
  déploiement). Inclut les **blocages par liaison**.
- Import : flux dans Synchro iCal (admin), relevés par le cron */15 min —
  nouvel événement → résa `ical` confirmée (même garde anti-conflit) ;
  déplacé → dates mises à jour ; disparu → résa future annulée ;
  conflit → refus + alerte tableau de bord. Délai Airbnb ~2 h assumé (plan § 6).

## Messages — les échanges clients vivent dans la plateforme

**Le système fonctionne sans email.** Table `messages` (fils entrants/sortants
par client et par résa), trois canaux qui convergent dans la même boîte :

- 💬 **Formulaire public** « Une question avant de réserver ? » (page de
  réservation, pot de miel anti-bot) ;
- 💬 **Voucher du client** : fil de conversation intégré — le client écrit,
  la réponse de l'équipe s'affiche au même endroit ;
- ✉️ **Email entrant** (une fois Email Routing activé) : même boîte, même fil.

Côté back-office : onglet **Messages** (badge tableau de bord), fil en bulles,
**réponse envoyée depuis la plateforme** (visible immédiatement sur le voucher,
doublée par email quand `EMAILS_ENABLED` — sinon journalisée en stub), message
proactif depuis la fiche résa (« 💬 Message au client »), marquage traité.

## Intégration email (boîte de réception + accusés + transfert)

- **Réception** : Cloudflare Email Routing (adresse du domaine, ex.
  `reservation@lesgitesdupremore.be`) → handler `email()` du Worker. Chaque
  mail est parsé (MIME maison : multipart, quoted-printable/base64,
  encoded-words), stocké dans `inbound_emails`, **rattaché à la résa** (réf
  `PM-2026-…` dans le sujet/corps, sinon email du client) et visible dans
  l'onglet **Messages** du back-office (badge sur le tableau de bord).
- **Accusé de réception automatique** : texte réglable dans Paramètres
  ({nom}/{reference} remplacés), **OFF par défaut** — anti-boucle intégré
  (jamais de réponse à un mail automatique, en-tête `Auto-Submitted` posé).
- **Transfert** : chaque mail entrant peut être relayé vers l'adresse
  personnelle configurée (doit être vérifiée dans Email Routing).
- **Envoi** (voucher, liens de paiement, rappels de solde) : Resend, journalisé
  dans `email_log`, réel uniquement si `EMAILS_ENABLED=true` + clé.
- **Test local sans DNS** : Messages → « Simuler un email entrant » (l'accusé
  éventuel est journalisé en stub). Adresse de contact publique : carte
  « Domaine » des Paramètres (affichée sur la page de réservation et le voucher).

Activation réelle (au déploiement uniquement) : activer Email Routing sur le
domaine (enregistrements MX gérés par Cloudflare), créer l'adresse, action
« Send to Worker » → `gites-platform`, vérifier l'adresse de transfert.
⚠️ Le domaine lesgitesdupremore.be appartient au père de Julien — accord requis.

## Import elloha (phase 2)

Réservations (admin) → « Importer elloha » : coller le CSV, **simulation
d'abord** (aucune écriture), puis import réel. Dédoublonnage par référence
elloha, paiements déjà encaissés repris, mêmes garde-fous anti-conflit.
`TODO_FORMAT_ELLOHA` : demander l'export réel à Julien au moment venu
(mapping d'en-têtes à ajuster dans `src/services/elloha-import.ts`).

## Déploiement (⚠️ RIEN n'est déployé — décision de Julien)

Runbook à exécuter LE MOMENT VENU, jamais sans son accord explicite.
Depuis le LOT A0, la config locale et la config de production sont **séparées**
dans `wrangler.jsonc` (bloc `env.production`) : on ne modifie plus le bloc
racine au déploiement, sans quoi tout `npm run dev` suivant fabriquait des
liens de paiement et des URLs iCal pointant sur la production.

1. `wrangler d1 create gites-platform` → recopier le `database_id` dans **les deux**
   blocs de `wrangler.jsonc` (racine pour le local, `env.production` pour la prod).
2. `npm run db:migrate:remote` (applique les migrations sur la base distante).
3. Régénérer les `ical_token` des unités (les valeurs du seed sont devinables :
   `local-dev-token-*`) + remplacer les tarifs TODO.
4. `env.production.vars.PUBLIC_BASE_URL` → URL publique réelle (décision D5).
5. Secrets de production (`--env production` sur chaque commande) :
   `wrangler secret put STRIPE_SECRET_KEY --env production` (**sk_test_** d'abord),
   puis `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` (+ `EMAILS_ENABLED=true`
   seulement sur GO), `BEDS24_REFRESH_TOKEN`, `BEDS24_WEBHOOK_KEY`,
   et **`ADMIN_TOKEN` — obligatoire, la garde admin est fail-closed**.
6. `wrangler deploy --env production`, puis webhook Stripe →
   `https://…/api/webhooks/stripe` (événements `checkout.session.completed`
   + `checkout.session.expired`), et webhook Beds24 → URL affichée dans la vue
   Canaux OTA du back-office.
7. Protéger `/admin` **ET `/api/admin/*`** par **Cloudflare Access** — ce sont
   deux surfaces distinctes, et une règle posée seulement sur `/admin` laisse
   les endpoints de données ouverts. Désactiver aussi la route
   `*.workers.dev` par défaut, qui contourne les règles du domaine custom.
8. Brancher les boutons « Réserver » du site WordPress Pré Moré vers `/book/`.

### Sauvegarde et restauration (à mettre en place AU déploiement)

Les migrations ne sont **pas** une sauvegarde : les rejouer reconstruit un
système vide, jamais les réservations. D1 Time Travel couvre « j'ai fait une
bêtise mardi » et rien d'autre (ni perte de compte, ni corruption découverte
tardivement).

```bash
npm run db:export:remote -- "sauvegardes/$(date +%F)-gites-platform.sql"
```

- Cadence : **hebdomadaire**, par un LaunchAgent du vault (cf. projet
  « LaunchAgents Tâches planifiées »). Le dump pèse quelques centaines de Ko.
- ⚠️ **Le dump ne doit jamais être versionné.** Il contient les données
  personnelles des voyageurs (noms, emails, téléphones, montants) et le dépôt est
  partagé. `sauvegardes/`, `backups/`, `*.sql.gz` et `*.dump` sont exclus par le
  `.gitignore` — ne pas les forcer avec `git add -f`. Les copies indépendantes de
  Cloudflare sont Time Machine et le disque local, pas git.
- **Tester la restauration une fois** : créer une base jetable, importer le
  dump, lancer `npm test` dessus. Une procédure jamais exécutée n'est pas une
  procédure.
- Restauration : `wrangler d1 create gites-restore` puis
  `wrangler d1 execute gites-restore --remote --file <dump>.sql`, vérifier les
  compteurs (`bookings`, `payments`, `guests`), puis basculer le `database_id`.

## Déploiement Infomaniak (Node + SQLite) — dev1.mdcdy.be

Le code métier est **identique** aux deux cibles : `src/` ne contient rien de
spécifique à Cloudflare. Seul le point d'entrée change.

| | Cloudflare | Infomaniak |
|---|---|---|
| Entrée | `src/index.ts` (Worker) | `node/server.mjs` (node:http) |
| Base | D1 | SQLite via `node/sqlite-d1.mjs` (`node:sqlite`) |
| Statiques | binding `ASSETS` | servis par `server.mjs` (+ en-têtes de sécurité et cache) |
| Cron | trigger `*/15 * * * *` | Planificateur de tâches → `GET /internal/cron?key=…` |
| Emails entrants | Email Routing → handler `email()` | **pas d'équivalent** (voir plus bas) |
| Auth admin | Cloudflare Access + `ADMIN_TOKEN` | `ADMIN_TOKEN` seul |

**Zéro dépendance à l'exécution.** On téléverse le code déjà compilé : ni
`npm install`, ni build sur le serveur. `node:sqlite` étant intégré au runtime,
il n'y a aucun module natif à compiler — d'où l'exigence **Node 22 minimum**.

### Préparer et envoyer

```bash
npm run build                        # tsc → dist/ + extensions ESM
cp .deploy.vars.example .deploy.vars # puis y mettre les identifiants FTP
python3 node/deploy-ftp.py --dry-run # contrôler la liste
python3 node/deploy-ftp.py           # FTPS, ~67 fichiers
```

Le script ne supprime jamais rien à distance et n'envoie ni `.env`, ni
`data/`, ni les sources.

### Côté Manager Infomaniak

1. **Site Node.js** : version **22 ou plus**, dossier d'exécution = racine du
   site, **pas de commande de build**, commande de démarrage `node node/server.mjs`.
2. **Variables d'environnement** : cf. `.env.example`. Obligatoires :
   `PUBLIC_BASE_URL=https://dev1.mdcdy.be`, `SQLITE_PATH`, `ADMIN_TOKEN`, `CRON_KEY`.
   ⚠️ Mettre `SQLITE_PATH` **hors du dossier déployé** — sinon un redéploiement
   pourrait écraser la base de production.
3. **Planificateur de tâches** (Outils avancés) : `https://dev1.mdcdy.be/internal/cron?key=…`
   toutes les **15 minutes** (leur fréquence maximale, exactement la cadence
   du cron Cloudflare).
4. **Un seul processus** — pas de mode cluster ni de réplicas : deux instances
   écrivant sur le même fichier SQLite casseraient le verrouillage.
5. Certificat SSL Let's Encrypt (fourni).

### Vérifier après déploiement

```bash
ADMIN_TOKEN=... CRON_KEY=... node node/verify-deploy.mjs https://dev1.mdcdy.be
```

13 contrôles, dont **le test décisif** : 18 réservations simultanées sur le même
créneau, une seule doit passer. Ce test valide le verrouillage réel du disque de
l'hébergeur — sur un stockage réseau, SQLite peut mal verrouiller. En local
(Node 25) : 1 acceptée / 17 refusées en 16 ms. **Si ce contrôle échoue sur le
serveur, ne pas ouvrir au public** : il faut alors basculer sur MySQL et
reconstruire le garde-fou anti-surbooking.

Le script annule tout seul les réservations de test qu'il a créées.

### Ce qui ne suit pas sur Infomaniak

- **Emails entrants** : le handler Cloudflare Email Routing n'a pas d'équivalent.
  À remplacer par une relève IMAP sur une boîte Infomaniak, ou à laisser de côté
  (les échanges clients passent déjà par la plateforme).
- **Cloudflare Access** : `ADMIN_TOKEN` devient la seule protection du
  back-office. La garde étant fail-closed, l'absence de jeton bloque tout — mais
  un vrai écran de connexion avec session reste souhaitable.

### Sauvegarde

La base est **un seul fichier**. La sauvegarder, c'est le copier :

```bash
sqlite3 "$SQLITE_PATH" ".backup '/chemin/sauvegardes/$(date +%F)-gites.db'"
```

À planifier en tâche hebdomadaire, et à rapatrier hors du serveur. Tester la
restauration une fois : une procédure jamais exécutée n'est pas une procédure.

## Sécurité

- API admin : garde **fail-closed** — sans `ADMIN_TOKEN` NI en-tête
  `Cf-Access-Jwt-Assertion`, toute route `/api/admin/*` répond 503. Comparaison
  du jeton à temps constant. Cloudflare Access reste la protection primaire en
  production, le jeton la défense en profondeur (les deux, pas l'un ou l'autre).
- Écritures Beds24 réservées à la production (`beds24WritesAllowed`) : le compte
  Beds24 n'a pas de bac à sable, une session de dev pousserait des prix de test
  jusqu'aux OTAs.
- Exports CSV : neutralisation de l'injection de formule Excel (`=`, `+`, `-`, `@`).
- Voucher public : accessible uniquement avec référence **et** email du client.
- Webhook Stripe : signature HMAC vérifiée (tolérance 5 min, comparaison temps constant).
- Simulateur dev-pay : automatiquement désactivé dès qu'une clé Stripe existe.
- Jamais de DELETE sur les résas (annulation = statut), `audit_log` sur toutes
  les écritures significatives.
