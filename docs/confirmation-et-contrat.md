# Confirmation de réservation et contrat de location PDF

Décision de Julien du 11/10/2026 : un client qui réserve en direct reçoit **un beau
mail de confirmation** avec, **en pièce jointe, son contrat de location en PDF**.
Airbnb et Booking envoient le leur ; ceci vaut pour les réservations directes
(source `direct`) et pour les ventes confirmées du back-office (téléphone).

## Ce qui part, et quand

Un seul mail, de type `confirmation` dans `email_log`. Il **remplace** l'ancien mail
« voucher » : le voucher n'est plus envoyé en plus (la page `voucher.html`, elle,
reste la consultation en ligne de la réservation). Les anciennes lignes
`kind = 'voucher'` du journal sont conservées telles quelles.

| Déclencheur | Où dans le code |
|---|---|
| Paiement des arrhes (ou du total) : webhook Stripe, simulateur de dev | `handlePaymentSuccess` (`src/services/booking-flow.ts`), au passage `pending` → `confirmed` |
| Vente du back-office confirmée d'office, avec une adresse e-mail | `POST /api/admin/bookings` (`src/api/admin.ts`) ; `"sendConfirmation": false` pour ne pas l'envoyer |
| Confirmation manuelle d'une option | `POST /api/admin/bookings/:id/confirm` avec `{"sendConfirmation": true}` (ancien nom `sendVoucher` accepté) |
| « Renvoyer la confirmation » (fiche réservation, écran `app/`) | `POST /api/admin/bookings/:id/resend-confirmation` (ancien nom `resend-voucher` accepté) |

Tout passe par `sendConfirmation()` (`booking-flow.ts`). **Sans doublon** : sauf
`force` (le bouton « Renvoyer »), il ne part qu'une fois par réservation. Un envoi
déjà journalisé, de type `confirmation` ou `voucher`, hors statut `failed`, bloque
l'envoi automatique ; un envoi `failed` peut être retenté. Deux déclenchements
simultanés (webhook rejoué, double clic) ne passent pas tous les deux : un verrou
(`confirmation_claims`, migration 0030, une ligne par réservation) est posé AVANT
l'envoi et rendu si l'envoi échoue. Le reçu de paiement
(`payment_receipt`) reste un mail à part, émis à chaque encaissement.

Le mail est en français ou en néerlandais selon `bookings.lang` (puis la langue du
client). Les conditions générales n'existent qu'en français : en néerlandais, le
mail et le contrat le disent (« De Franse versie is rechtsgeldend »).

## Le mail

`src/services/confirmation.ts`, `buildConfirmationEmail()` : objet
« Confirmation de réservation <réf> — <domaine> », version HTML (tableaux en
styles en ligne, 600 px, bouton « Voir ma réservation » vers la page de la
réservation) et version texte (c'est elle que garde le journal). Rubrique « Ce que
vous devez savoir » : horaires, adresse, contact, solde et échéance, caution si
demandée, contrat joint, renvoi vers l'article 5 (annulation).

Les données du client passent par `esc()` dans le HTML ; objet et texte reçoivent
des valeurs ramenées à une ligne. Les coordonnées `TODO_…` du domaine ne sortent
jamais. Le texte du mail se change dans les deux dictionnaires `FR` et `NL` en tête
du fichier.

## Le contrat PDF

`src/services/contrat.ts`, `buildContractPdf()`, fichier `Contrat-<référence>.pdf`.
Générateur PDF maison, sans dépendance : `src/core/pdf.ts` (A4, Helvetica, WinAnsi,
tableaux, pagination, pied de page « Page n / N »). Contenu :

1. les parties : l'exploitant (domaine, adresse, contact, et la phrase « L'exploitant
   est … » de l'article 1 des CGV) et le locataire ;
2. l'hébergement loué ;
3. le séjour : dates en toutes lettres, heures d'arrivée et de départ, nuits, occupants ;
4. le prix, ligne par ligne d'après le devis figé de la réservation, et le total ;
5. le paiement : arrhes (avec leur pourcentage) et solde avec son échéance, montant
   réglé à la date d'émission, caution seulement si elle est > 0, puis **les
   articles 4 et 5 des CGV reproduits mot pour mot** ;
6. les conditions générales : version, date et heure (Bruxelles) d'acceptation en
   ligne. Sans acceptation enregistrée (vente prise par le propriétaire), le contrat
   le dit au lieu d'inventer une date ;
7. signatures : « Fait à Redu, le … » et la mention que l'acceptation en ligne et le
   paiement des arrhes valent signature ;
8. en annexe, le texte complet des CGV en base (`settings.cgv_text`).

**Le contrat ne crée aucune règle.** Les chiffres viennent de la réservation ; les
règles (arrhes, solde à 30 jours, annulation) sont celles des CGV en base. Changer
une règle = changer `cgv_text` (nouvelle version, nouvelle migration sur le modèle de
la 0019) : le contrat suit sans toucher au code.

### Où modifier le texte du contrat

- **Libellés du contrat** (titres, phrases d'acceptation, signatures) : les deux
  dictionnaires `FR` et `NL` de `src/services/contrat.ts`. Le lieu de signature est
  la constante `LIEU_SIGNATURE` (« Redu »).
- **Mise en page** (marges, polices, tableaux) : `src/core/pdf.ts`.
- **Règles de paiement et d'annulation, identité de l'exploitant** : les CGV en base.
- Après modification : `npx vitest run test/confirmation-contrat.test.ts`. Pour voir
  le rendu : `SAMPLE_PDF_DIR=/chemin npx vitest run test/confirmation-contrat.test.ts -t "exemple"`
  écrit un contrat et un mail FR et NL d'exemple dans ce dossier.

## Accès au contrat

- Back-office : `GET /api/admin/bookings/:id/contrat.pdf` (même garde que tout
  `/api/admin/*`, toute réservation) ; bouton « Contrat PDF » dans la fiche
  réservation de l'écran `app/`, avec « Renvoyer la confirmation ».
- Client : `GET /api/public/bookings/:référence/contrat.pdf?email=…` (même contrôle
  que sa page de réservation : référence + e-mail), **réservation confirmée
  seulement**.

## Transports

`queueEmail` accepte `bodyHtml` et `attachments` ; le journal (`email_log.attachments`,
migration 0030) garde nom et taille de chaque pièce jointe, jamais le contenu.
- SMTP (`node/smtp.mjs`) : `multipart/alternative` (texte + HTML) dans un
  `multipart/mixed` quand il y a des pièces jointes, base64 en lignes de 76 ; nom de
  fichier assaini (ASCII, sans guillemet ni saut de ligne). Sans HTML ni pièce
  jointe, le message reste un simple `text/plain`.
- Resend : `html` et `attachments` (contenu en base64).
- Mode stub (`EMAILS_ENABLED` ≠ `true`) : le mail est journalisé (`status = stub`),
  rien ne part.
