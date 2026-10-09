# Journal des séances

Une entrée par séance de travail : ce qui a été fait, ce qui reste, ce qui
attend quelqu'un. Les décisions elles-mêmes vont dans `docs/decisions.md`.

## 2026-10-09 (soir) — Méthode Greffe

Décision de Julien du jour : « go ».

Fait (branche `chore/methode-greffe`) :

- `Makefile` : `make installer`, `make dev`, `make test`, `make check`,
  `make sauvegarde`, `make livrer`, `make livrer-essai`, `make sonde-prod`,
  `make sonde-essai`. `make check` marque le commit vérifié quand l'arbre est
  propre ; les deux `livrer` refusent un arbre modifié ou un commit sans `check`
  vert, et sauvegardent la base avant toute migration distante.
- Environnement d'essai : env `essai` dans `wrangler.jsonc`, Worker
  `gites-platform-essai`, base D1 `gites-platform-essai` (créée), courriels,
  Beds24 et Stripe coupés, `ADMIN_TOKEN` d'essai dans `.secrets.essai` (gitignoré).
- `scripts/livrer.py` : la chaîne des deux `livrer` (gardes, verrou par cible,
  sauvegarde, migrations, déploiement, sonde qui lit le JSON) ; le make d'Apple
  (3.81) ignore `.SHELLFLAGS`, la logique ne vit donc pas dans le Makefile.
- `scripts/sauvegarde_nuit.py` et LaunchAgent `com.julien.gites-sauvegarde`
  (3 h 30) : export de la base de production, 30 jours gardés (7 au moins),
  une ligne par passage dans `~/Library/Logs/gites-sauvegarde.log` ; un export
  n'est gardé que s'il se rejoue entier dans une base SQLite en mémoire.
- Contre-relecture Codex du Makefile et des deux scripts : voir la PR.
- `scripts/check-images.mjs` : le chemin du dépôt n'était pas décodé
  (`%F0%9F%94%A7` pour l'émoji) ; la vérification échouait sur le Mac.
- Tests : cinq tests tombaient depuis le 04/09/2026 sans changement de code —
  `aujourd'hui + 300 jours` entrait dans la saison « juillet-août 2027 » du seed.
  Nouveau `test/helpers/dates.ts` (`horsSaisonsDuSeed`).

Reste, et attend :

- **Julien** : `npx wrangler login` dans un terminal (le jeton de wrangler a
  expiré : sans lui, ni sauvegarde, ni livraison, ni essai). Puis
  `make livrer-essai` (première livraison de l'essai) et `make sauvegarde`.
- **Julien** : transfert du dépôt vers `Almarcegui/gites-platform`.
- D'autres tests partent de dates relatives (`+200` à `+330` jours) qui
  croiseront les saisons datées du seed au fil des mois : à passer par
  `horsSaisonsDuSeed` au cas par cas.
