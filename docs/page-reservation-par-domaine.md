# Page de réservation d'un domaine

Chaque domaine a sa page : `/reserver/<slug>/`. Aujourd'hui une seule existe,
celle du Pré Moré (`public/reserver/pre-more/index.html`). Le tunnel générique
`/book/` reste en place (anciens liens, mails, iframe WordPress, Moulin).

## Créer la page d'un domaine

Copier le fichier vers `public/reserver/<slug>/index.html` et changer **une
ligne**, en tête du `<body>` :

```html
<script>window.GP_PROPERTY = "pre-more";</script>   <!-- → le slug du domaine -->
```

Le slug est celui de la table `properties` (`pre-more`, `moulin-braives`).
Le code JS et le CSS ne sont pas copiés : la page charge `/book/book.js` et
`/book/book.css`. Si on veut, adapter dans la copie le `<title>`, la meta
description et le lien « Retour au site » (`#backSite`, `/` par défaut).

## Les deux autres endroits à toucher

1. `public/book/pages.js` **et** `src/core/domain-pages.ts` : ajouter
   `"<slug>": "/reserver/<slug>/"` (un test vérifie que les deux tables
   concordent). C'est ce qui fait que le voucher, la page d'annulation et le
   lien de relance rouvrent la page du domaine, et non `/book/`.
2. Repointer les liens du site (`/book/?property=<slug>&unit=…` devient
   `/reserver/<slug>/?unit=…`), puis ajouter le slug à
   `test/reserver-pre-more.test.ts`.

Aucun changement de serveur : `/reserver/` est déjà intégrable en iframe (même
règle que `/book/`, `isEmbeddablePath` dans `src/services/http-headers.ts`).

## Comportement

- Le domaine vient de la page, jamais de l'adresse : un `?property=` est ignoré
  (et retiré de l'adresse). `unit`, `checkin`, `checkout`, `adults`, `children`
  et `lang` sont acceptés.
- Pas d'accueil multi-domaines ni de choix de domaine sur cette page.

> [!warning] Moulin de Braives
> Ne pas créer sa page tant qu'il n'a pas de compte Stripe : ses réservations en
> ligne sont refusées (PR #160).

## Vérifier

```bash
npx vitest run test/reserver-pre-more.test.ts
npx tsc -p tsconfig.build.json && node node/fix-esm-imports.mjs
node node/smoke-test.mjs                 # page servie, en-têtes d'iframe
node scripts/e2e-reserver.mjs            # parcours complet, FR/NL, 375 et 1440 px
```
