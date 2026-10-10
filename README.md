# Gites Platform — plateforme de gestion locative propriétaire

Réservation directe + paiement en ligne + tarification fine + statistiques pour
**Les Gîtes du Pré Moré** (Redu) et, en phase 2, **Le Moulin de Braives** —
en remplacement d'elloha (~857 €/an).

Contexte, décisions et roadmap : `🏠 Privé/Plateforme Gestion Gîtes/`
(00 – Memory + Plan v1 + Wireframe v1).

## Démarrer quand on arrive sur le projet

Le parcours d'installation complet est dans **[`CONTRIBUTING.md`](CONTRIBUTING.md)**.
Ce qui suit, ce sont les **trois pièges** qui font perdre des heures parce qu'ils
ne se devinent pas — chacun est documenté en détail à l'endroit où on le
rencontre.

| Le piège | Le symptôme | Où c'est expliqué |
|---|---|---|
| **Un `;` ou un `--` dans un littéral SQL casse la migration** — le découpage des fichiers est volontairement naïf, et il est implémenté deux fois | La suite de tests tombe entièrement, avec un message qui ne pointe pas vers la vraie cause. **Déjà arrivé deux fois** | [`migrations/README.md`](migrations/README.md) |
| **`vitest-pool-workers` est inutilisable** — il casse sous les chemins contenant un emoji, et le dossier de travail en contient un | `ERR_RUNTIME_FAILURE — No such module "node:vm"`. Les tests passent par **Miniflare en direct** (`test/helpers/`) — ne « réparez » pas la config | [`test/README.md`](test/README.md) |
| **`ADMIN_TOKEN` est obligatoire même en local** depuis que la garde admin est *fail-closed* | Toutes les routes `/api/admin/*` répondent **503** et le back-office affiche une page vide déroutante | [`CONTRIBUTING.md`](CONTRIBUTING.md) § 1 et § 10 |

Le minimum pour démarrer :

```bash
npm install
cp .dev.vars.example .dev.vars   # puis y renseigner ADMIN_TOKEN (ex. dev:dev)
npm run db:migrate:local         # ⚠️ à refaire après chaque git pull
npm run dev -- --port 8788       # ⚠️ jamais 8787, occupé par un autre service
npm test && npm run typecheck    # doivent être verts avant toute PR
```

Deux repères pour lire le code :

- **La source de vérité, c'est le SQL**, pas le code applicatif. Le schéma vit
  dans `migrations/`, et le code s'y conforme.
- **Les tests sont le filet.** `createTestDb()` rejoue toutes les migrations sur
  une base neuve à chaque exécution : ce qui casse le schéma se voit tout de suite.

Architecture du code : [`ARCHITECTURE.md`](ARCHITECTURE.md).
Organisation du travail à deux : [`COLLABORATION.md`](COLLABORATION.md).
Décisions de Julien : [`docs/decisions.md`](docs/decisions.md) ; séances :
[`docs/journal-des-seances.md`](docs/journal-des-seances.md).

## Les commandes du dépôt (`make`, depuis le 09/10/2026)

| Commande | Ce qu'elle fait |
|---|---|
| `make installer` | `npm ci` |
| `make dev` | migrations locales, puis serveur local sur 8788 |
| `make test` | les tests, un fichier après l'autre (`--no-file-parallelism`) |
| `make check` | **tout ce qui doit passer avant de dire « fini »** : typecheck, tests, signatures des images, script de sauvegarde. Sur un arbre propre, marque le commit vérifié |
| `make sauvegarde` | export horodaté de la base de **production** dans `sauvegardes/` (lecture seule) |
| `make livrer-essai` | vers l'**essai** : sauvegarde de la base d'essai, migrations, déploiement, sonde |
| `make livrer` | vers la **production**, sur le « go » de Julien et depuis `main` seulement : sauvegarde, migrations, déploiement, sonde |
| `make sonde-prod`, `make sonde-essai` | `/api/public/health`, une minute au plus |

Les deux `livrer` passent par `scripts/livrer.py` : ils refusent un arbre modifié
et un commit sur lequel `make check` n'est pas passé, tiennent un verrou par cible
jusqu'à la sonde (deux livraisons vers la même base ne s'entrelacent pas, même
depuis deux worktrees), et sans sauvegarde réussie aucune migration distante ne
part. Seul le wrangler du dépôt (`node_modules/.bin`) est employé.
**Jamais `make check | tail … && git commit`** : un tube rend le code de sortie
de sa dernière commande, et l'échec passe. `make check` se lance seul.

### L'environnement d'essai

**https://gites-platform-essai.j-decartier.workers.dev** — Worker et base D1
(`gites-platform-essai`) à part : rien de ce qu'on y fait ne touche la production.
Courriels coupés, paiement simulé, Beds24 coupé (aucun secret `BEDS24_*` n'y est
posé, et il ne faut pas en poser : en https, `BEDS24_WRITE_ENABLED=false` ne
suffit pas, voir `wrangler.jsonc`). Son `ADMIN_TOKEN`, distinct de celui de la
production, est dans `.secrets.essai` (gitignoré, dans le clone principal) ;
`make livrer-essai` le pose à chaque déploiement. À la première livraison, la base
d'essai n'a encore aucune table : sa sauvegarde le constate et laisse passer
(l'essai seulement ; une base de production vide ou incomplète est refusée).

### La sauvegarde de nuit

Le LaunchAgent `com.julien.gites-sauvegarde` lance chaque nuit à 3 h 30 (ou au
réveil du Mac) `scripts/sauvegarde_nuit.py` **du clone principal** : export de la
base de production dans `sauvegardes/AAAA-MM-JJ-HHMMSS-gites-platform.sql`,
30 jours gardés et 7 fichiers au moins, une ligne par passage dans
`~/Library/Logs/gites-sauvegarde.log` (« OK … » ou « ÉCHEC … », jamais l'URL de
téléchargement signée que wrangler affiche), sortie 1 sur échec. Il a besoin
d'une session wrangler valide (`npx wrangler login`) : sinon, chaque nuit écrit
« ÉCHEC … Not logged in ». Arrêt : `launchctl bootout gui/501/com.julien.gites-sauvegarde`.

### Le dépôt sur GitHub

Aujourd'hui `jdecartier-glitch/gites-platform` (le compte actif de `gh`,
`Almarcegui`, n'y a pas accès : `gh auth switch -u jdecartier-glitch` avant un
push). Transfert prévu vers **`Almarcegui/gites-platform`**, en attente d'un geste
de Julien depuis le compte propriétaire actuel ; ensuite,
`git remote set-url origin https://github.com/Almarcegui/gites-platform.git`.

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
| Paiement | Stripe par API REST — **Payment Element intégré** (carte, Bancontact, Apple/Google Pay) dès que les deux clés sont posées, sinon Checkout hébergé ; **mode stub** intégré sans clé. **Mode TEST uniquement** tant que l'entité n'est pas tranchée |
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
npm test                     # 152 tests (moteurs, D1, courses, API, iCal, import, LOT A0)
npm run typecheck
```

- Back-office : http://localhost:8788/admin/
- Page publique : http://localhost:8788/book/
- Sans clé Stripe : le paiement passe par `/book/dev-pay.html` (simulateur local).
  Avec `STRIPE_SECRET_KEY` **et** `STRIPE_PUBLISHABLE_KEY` : formulaire de paiement
  intégré au tunnel (§ Stripe ci-dessous), sans redirection hors du site.
- Secrets locaux : copier `.dev.vars.example` → `.dev.vars`. **`ADMIN_TOKEN` y est
  désormais obligatoire** (garde fail-closed) : format `identifiant:motdepasse`,
  plusieurs paires séparées par des virgules. Le gabarit livre `dev:dev`, qui
  suffit en local. Laissé vide, tout `/api/admin/*` répond 503.
- Première connexion : une base neuve n'a **aucun compte**. On entre par
  `ADMIN_TOKEN` via `/admin/login.html`, puis on crée les vrais comptes dans
  `/admin/#/users` (table `admin_users`, migration `0012`). Détail dans
  `CONTRIBUTING.md` § « Première connexion au back-office ».
- Le Moulin de Braives est seedé par la migration `0004` — il n'y a pas de
  script `db:seed:moulin` ni de dossier `seed/`.

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
test/                  12 fichiers, 152 tests
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
  généraux — ménage et charges » (plus jamais en option payante — les
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
- **Prix des places de marché** : le prix conseillé est `prix direct ×
  (1 + majoration %)`, arrondi au centime (défauts Airbnb +18 %, Booking +18 %,
  Abritel +15 %). **Il ne s'applique que si le propriétaire choisit un canal de
  référence** dans *Plateformes* — sinon les plateformes reçoivent le prix de
  vente directe. Le prix direct n'est jamais modifié par ce réglage.

## Paiement (Stripe)

Trois modes, décidés par les seules variables d'environnement — aucun code à
changer pour passer de l'un à l'autre.

| Variables posées | Ce que voit le client | Pour quoi |
|---|---|---|
| aucune | `/book/dev-pay.html`, le simulateur local | développement, tests |
| `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` | **Payment Element intégré** à l'étape 4 du tunnel et sur le voucher | le mode cible (issue #26) |
| `STRIPE_SECRET_KEY` seule, ou `STRIPE_UI=checkout` | redirection vers Checkout hébergé | repli, et liens de paiement envoyés par email depuis le back-office |

**Moyens de paiement proposés** : carte (qui porte aussi **Apple Pay** et
**Google Pay** dans le Payment Element) et **Bancontact** — déclarés
explicitement dans `src/services/stripe.ts` (`PAYMENT_METHOD_TYPES`), pas
délégués à un réglage du tableau de bord Stripe. Apple Pay et Google Pay
supposent en plus l'enregistrement du domaine dans Stripe (*Settings → Payment
methods → Apple Pay → Add domain*) : sans lui, le formulaire fonctionne, les
deux boutons de portefeuille n'apparaissent simplement pas.

**Clés à poser** (mode test d'abord — `sk_test_` / `pk_test_`) :

```
STRIPE_SECRET_KEY=sk_test_…        # secret, ne sort jamais du Worker
STRIPE_PUBLISHABLE_KEY=pk_test_…   # confiée au navigateur (endpoint /api/public/payment-config)
STRIPE_WEBHOOK_SECRET=whsec_…      # vérification HMAC du webhook
```

**Événements du webhook à activer** sur `https://…/api/webhooks/stripe` :

- `payment_intent.succeeded` — **c'est lui qui crédite**, jamais le retour navigateur ;
- `payment_intent.payment_failed` — solde la tentative, ne touche pas à la réservation ;
- `checkout.session.completed` et `checkout.session.expired` — flux hébergé, toujours utilisé par les liens de paiement du back-office.

**Bancontact redirige** vers la banque du client et le ramène sur `merci.html`
(acompte) ou sur le voucher (solde) avec un `redirect_status`. Ce paramètre est
affiché honnêtement (« paiement en cours de traitement ») et **ne crédite
rien** : la page attend le webhook.

**Un échec de paiement n'annule pas la réservation.** Le blocage de 30 minutes
continue de courir, le formulaire propose « Réessayer », et le voucher rouvre un
paiement à tout moment (`POST /api/public/bookings/:reference/pay`).

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

**Nouveau compte (10/10/2026) — recréer la propriété depuis le back-office.**
`GET /api/admin/beds24/status?property=1` rend aussi le compte relié (`compte` :
numéro, nom du jeton, droits — l'API ne donne pas le nom d'utilisateur), l'état
du mapping (`actif` / `perime` / `absent`) et `creationPossible`.
`GET /api/admin/beds24/creer-propriete/apercu` montre ce qui partirait (aucun
réseau) ; `POST /api/admin/beds24/creer-propriete { propertyId, confirmer: true }`
crée la propriété et une room par maison (le Domaine entier reste direct-only),
écrit le mapping, puis envoie textes et équipements
(`src/services/beds24-propriete.ts`, contenu dans `src/core/beds24-contenu.ts`).
Photos, GPS, lits, wifi : rendus sous « à compléter dans Beds24 ». Bouton dans
Canaux OTA. `BEDS24_WRITE_ENABLED=false` bloque désormais toute écriture, même
en https (environnement d'essai).

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
  comprise) + prix (rateCalendar, en euros, majoré du canal de référence si un
  canal est appliqué — cf. § *Majoration des prix poussés*) + min-nuits, jours
  regroupés en plages compactes ; POST `/inventory/rooms/calendar`. Accrochée au **cron 15 min**
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

### Majoration des prix poussés (issue #31)

Airbnb et Booking prennent une commission : le tarif qu'on y affiche doit être
plus élevé que le prix de vente directe, sinon la commission sort de la poche du
propriétaire. Le prix conseillé était calculé et affiché depuis la PR #62, mais
rien ne permettait de **l'appliquer**.

Il n'existe qu'un seul endroit où un « prix par canal » a une réalité : le
calendrier poussé vers Beds24 (`price1`). C'est donc là que la majoration
s'applique, à partir d'un **canal de référence** choisi par le propriétaire.

- **Où** : back-office → *Plateformes*, carte « Prix envoyés aux plateformes ».
  Le même bouton existe dans la saisie d'un prix (Calendrier → Prix), à côté du
  prix conseillé.
- **Effet** : `price1 = prix direct × (1 + majoration du canal)`. Le réglage est
  global (une seule valeur, `pricing.push_channel` dans `app_settings`), donc
  **aucune migration**, et il se retire d'un clic (« Ne plus majorer »).
- **Par défaut : aucun canal appliqué** — les plateformes reçoivent le prix de
  vente directe, exactement comme avant.
- **Le prix de vente directe n'est jamais modifié.** La base ne contient qu'un
  prix : celui du site. Le prix des plateformes est calculé au moment du push.
- **Le plancher et le plafond de l'hébergement bornent la saisie**, pas ce prix
  dérivé : un plafond à 210 € n'empêche pas 236 € de partir sur Airbnb, c'est
  voulu (le plafond protège de la faute de frappe à la saisie).
- Un canal retiré de la liste des majorations cesse de majorer — pas de
  majoration fantôme. Poser ou retirer le réglage est journalisé
  (`pricing.push_channel`) et **déclenche immédiatement un push**.

---

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

## Anti-robot du formulaire de réservation (Cloudflare Turnstile)

Le formulaire public pose un blocage de 30 minutes sur des dates **avant tout
paiement**. Deux protections se complètent (issue #6) :

1. **Plafonds serveur** — 3 options de paiement simultanées et 8 réservations
   par heure glissante, par email **et** par IP. Toujours actifs, rien à
   configurer.
2. **Turnstile** — le captcha invisible de Cloudflare, gratuit et sans cookie
   de pistage. **Éteint par défaut.**

### Ce qui se passe sans clés (état actuel)

Rien. Aucun script tiers n'est chargé dans le tunnel, aucun jeton n'est demandé
au visiteur, aucune vérification n'est faite côté serveur. C'est volontaire :
le développement local, la suite de tests et le parcours de réservation
fonctionnent à l'identique sans compte Cloudflare.

### Créer la paire de clés (5 minutes, action propriétaire)

1. Tableau de bord Cloudflare → menu **Turnstile** → **Add widget**.
2. Nom : `gites-platform` ; **Hostnames** : le domaine public du site — et
   `localhost` en plus si tu veux tester en local avec les vraies clés.
3. **Widget Mode : Managed** (le mode recommandé : invisible pour un visiteur
   normal, défi seulement en cas de doute).
4. Cloudflare affiche alors deux valeurs :
   - **Site Key** (publique, `0x4AAAA…`) — elle est servie au navigateur, elle
     n'a pas à être protégée ;
   - **Secret Key** (`0x4AAAA…`) — elle ne doit **jamais** sortir du Worker ni
     du dépôt.

### Poser les clés

En local, dans `.dev.vars` (gitignoré) :

```
TURNSTILE_SITE_KEY=0x4AAAAAAA…
TURNSTILE_SECRET_KEY=0x4AAAAAAA…
```

En production :

```bash
wrangler secret put TURNSTILE_SITE_KEY --env production
wrangler secret put TURNSTILE_SECRET_KEY --env production
```

> [!important]
> **Les deux clés vont ensemble.** Une seule des deux = configuration
> incomplète : le code considère alors la fonctionnalité éteinte plutôt que de
> faire échouer toutes les réservations. Pour désactiver Turnstile, il suffit de
> retirer un des deux secrets (`wrangler secret delete …`) et de redéployer.

### Tester sans compte

Cloudflare publie des clés de test qui ne valident rien mais font tourner le
vrai widget. Utiles pour vérifier le parcours :

| Cas | `TURNSTILE_SITE_KEY` | `TURNSTILE_SECRET_KEY` |
|---|---|---|
| Passe toujours | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| Échoue toujours (widget bloqué) | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |
| Jeton valide, vérification refusée | `1x00000000000000000000AA` | `2x0000000000000000000000000000000AA` |

### Ce que voit le visiteur

Le widget s'affiche à l'étape 3, entre l'acceptation des CGV et le bouton de
paiement. Un jeton absent ou refusé arrête la réservation **avant toute
écriture** (ni client créé, ni créneau gelé) avec un message qui dit quoi faire.
Si le service Cloudflare est injoignable, la réservation est refusée en 503 avec
la sortie de secours (nous contacter) : la protection ne se désarme pas toute
seule.

**Le jeton n'est jamais journalisé** — ni dans `audit_log`, ni dans la réponse.
Seuls les codes d'erreur de Cloudflare (`invalid-input-response`,
`timeout-or-duplicate`…) sont tracés, sous l'action `booking.captcha_refused`.

---

## Déploiement (en production depuis le 03/08/2026 — décision de Julien)

**Depuis le 09/10/2026, on déploie par `make livrer` (production) et
`make livrer-essai` (essai), jamais par un `wrangler deploy` à la main** (§ Les
commandes du dépôt). Le runbook ci-dessous décrit la mise en place initiale ;
chaque déploiement en production reste soumis à l'accord explicite de Julien.
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
   puis `STRIPE_PUBLISHABLE_KEY` (**pk_test_** correspondante — sans elle le
   paiement retombe sur Checkout hébergé), `STRIPE_WEBHOOK_SECRET`,
   `RESEND_API_KEY` (+ `EMAILS_ENABLED=true`
   seulement sur GO), `BEDS24_REFRESH_TOKEN`, `BEDS24_WEBHOOK_KEY`,
   et **`ADMIN_TOKEN` — obligatoire, la garde admin est fail-closed**.
   Optionnel mais recommandé : `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`
   (anti-robot du formulaire public — cf. § Anti-robot ci-dessus ; les deux
   ensemble ou aucune des deux).
6. `wrangler deploy --env production`, puis webhook Stripe →
   `https://…/api/webhooks/stripe`, avec **quatre** événements activés :
   `payment_intent.succeeded`, `payment_intent.payment_failed` (paiement
   intégré) **et** `checkout.session.completed`, `checkout.session.expired`
   (Checkout hébergé, toujours utilisé par les liens de paiement du
   back-office). Puis webhook Beds24 → URL affichée dans la vue Canaux OTA du
   back-office.
7. Protéger `/admin` **ET `/api/admin/*`** par **Cloudflare Access** — ce sont
   deux surfaces distinctes, et une règle posée seulement sur `/admin` laisse
   les endpoints de données ouverts. Désactiver aussi la route
   `*.workers.dev` par défaut, qui contourne les règles du domaine custom.
8. Brancher les boutons « Réserver » du site WordPress Pré Moré vers `/book/`.

### Sauvegardes

Les migrations ne sont **pas** une sauvegarde : les rejouer reconstruit un
système vide, jamais les réservations. D1 Time Travel couvre « j'ai fait une
bêtise mardi » et rien d'autre (ni perte de compte, ni corruption découverte
tardivement).

#### Sauvegarder

```bash
make sauvegarde              # export horodaté (scripts/sauvegarde_nuit.py)
```

Le script ne fait que **lire** la production. Il écrit
`sauvegardes/AAAA-MM-JJ-HHMMSS-gites-platform.sql` (dans le clone principal, même
lancé depuis un worktree), une ligne dans `~/Library/Logs/gites-sauvegarde.log`,
et refuse un export qui ne se rejoue pas entièrement dans une base SQLite en
mémoire (`integrity_check`, tables attendues) — un export tronqué qui inspire
confiance est pire que pas de sauvegarde du tout.
Rotation : 30 jours, et toujours les 7 plus récentes. `make livrer` le lance
avant toute migration distante. L'ancien `scripts/backup-d1.sh` (journal
`sauvegardes/journal-sauvegardes.log`, nom au jour près) n'est plus appelé.

⚠️ **Le dump ne doit jamais être versionné.** Il contient les données
personnelles des voyageurs (noms, e-mails, téléphones, montants) et le dépôt est
partagé. `sauvegardes/`, `backups/`, `*.sql.gz` et `*.dump` sont exclus par le
`.gitignore` — ne pas les forcer avec `git add -f`. Les copies indépendantes de
Cloudflare sont Time Machine et le disque local, pas git.

#### Automatiser (une fois, sur le Mac du propriétaire)

**Fait le 09/10/2026** : LaunchAgent `com.julien.gites-sauvegarde`, chaque nuit à
3 h 30 (§ La sauvegarde de nuit, plus haut). Le gabarit hebdomadaire ci-dessous
(`backup-d1.sh`, dimanche 8 h) n'a jamais été installé ; il reste pour mémoire.

`scripts/com.julien.gites-backup.plist.example` est un **gabarit** : il déclenche
le script tous les dimanches à 8 h. Installation :

```bash
sed "s|CHEMIN_DU_PROJET|$PWD|g" scripts/com.julien.gites-backup.plist.example \
  > ~/Library/LaunchAgents/com.julien.gites-backup.plist
launchctl load ~/Library/LaunchAgents/com.julien.gites-backup.plist
launchctl start com.julien.gites-backup     # vérifier tout de suite
```

Ajuster `PATH` dans le plist s'il ne contient pas le dossier de `npx`
(`dirname "$(command -v npx)"`) : launchd ne lit ni `.zshrc` ni `.bash_profile`.

#### Restaurer

Restauration vers une base **jetable** d'abord, jamais directement sur la
production :

```bash
wrangler d1 create gites-restore
wrangler d1 execute gites-restore --remote --file sauvegardes/<date>-gites-platform.sql
```

Vérifier les compteurs avant de basculer le `database_id` de `wrangler.jsonc` :

```sql
SELECT (SELECT COUNT(*) FROM properties)  AS domaines,
       (SELECT COUNT(*) FROM units)       AS hebergements,
       (SELECT COUNT(*) FROM bookings)    AS reservations,
       (SELECT COUNT(*) FROM guests)      AS clients,
       (SELECT COUNT(*) FROM payments)    AS paiements,
       (SELECT COUNT(*) FROM admin_users) AS comptes;
```

> D1 refuse un `UNION ALL` de plus de quelques termes
> (`too many terms in compound SELECT`) : d'où les sous-requêtes.

#### Restauration réellement testée — 10/08/2026

Une procédure jamais exécutée n'est pas une procédure. Le dump de production du
**10/08/2026** (140 Ko, 1 029 lignes, 20 tables) a été réimporté dans une base
jetable, sur les deux moteurs, avec des compteurs identiques au dump :

| Table | Restauré |
|---|---|
| `properties` | 2 (Les Gîtes du Pré Moré, Le Moulin de Braives) |
| `units` | 4 (Maison du Scieur, Scierie, Domaine entier, Le Moulin) |
| `admin_users` | 3 |
| `rate_rules` | 7 |
| `messages` | 3 |
| `app_settings` | 2 |
| `audit_log` | 664 |
| `bookings` / `guests` / `payments` | 0 — la production n'a pas encore de réservation réelle |

Ce test porte donc sur les données de référence et les comptes du back-office ;
il **ne prouve pas encore** la restauration de réservations réelles. À refaire
après les premières réservations, et à noter ici.

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
- CSP (report-only) : `js.stripe.com` (script + frame) et `api.stripe.com`
  (connect) sont les **seules** origines ouvertes pour le paiement.
- Simulateur dev-pay : automatiquement désactivé dès qu'une clé Stripe existe.
- Formulaire public : plafonds de holds et de cadence toujours actifs, plus
  Turnstile quand les deux clés sont configurées (jeton vérifié avant toute
  écriture, jamais journalisé).
- Jamais de DELETE sur les résas (annulation = statut), `audit_log` sur toutes
  les écritures significatives.
