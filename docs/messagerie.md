# Messagerie : tous les messages dans la plateforme

Décision de Julien du 11/10/2026 : la boîte Gmail dédiée `lesgitesdupremore@gmail.com` est
l'adresse de contact des gîtes. La plateforme la relève, rattache chaque mail à sa réservation,
et on répond **depuis Messages**. On n'écrit jamais à la main dans Gmail : l'objectif est de
réduire les mails au minimum, tout passe par l'outil.

## Les origines

Chaque message porte son origine, avec le même mot partout (liste, fil, carte « Aujourd'hui »,
filtre) :

| Origine | D'où vient le message | Colonne `messages.channel` | Comment on répond |
|---|---|---|---|
| **E-mail** | la boîte Gmail des gîtes (relève IMAP) | `email` | par SMTP, dans le même fil |
| **Airbnb**, **Booking**, **Vrbo** | les canaux, relevés par Beds24 | `beds24` (+ `channel_messages`) | sur le canal, par Beds24 |
| **Site** | formulaire de contact du site et voucher du client | `form` | par mail au client (si l'envoi est actif) |

Un canal qui n'est aucun de ces trois (Expedia…) garde son nom. Le vocabulaire vient d'un seul
endroit : `app/src/canaux/canal.ts` (`originOf`, `sourceLabel`).

Les mails relevés vont dans `messages`, **pas** dans `channel_messages` : cette table est celle de
Beds24 (identifiant de réservation Beds24 obligatoire), un mail n'en a pas. `messages` est déjà la
boîte unique (liste « À répondre », fil, réponse), et reçoit déjà les mails de Cloudflare Email
Routing.

## La relève

- **Où** : `node/imap.mjs` (client IMAP maison, `node:tls`, zéro dépendance), injecté en
  `env.IMAP_FETCH` par `node/server.mjs`. Logique : `src/services/mailbox.ts`.
- **Quand** : au cron (toutes les 15 min, `/internal/cron`), et, en filet, toutes les
  `MAILBOX_POLL_MINUTES` (10 par défaut) tant que le processus Node vit. Un **bail en base** (5 minutes,
  expire seul après un plantage) interdit deux relèves à la fois, même entre deux instances du
  site, et le curseur ne recule jamais à `UIDVALIDITY` égale.
- **Lecture seule** : la boîte est ouverte en `EXAMINE` ; rien n'y est marqué lu, déplacé ni
  supprimé. Le client n'envoie que `CAPABILITY`, `LOGIN`, `EXAMINE`, `UID SEARCH`, `UID FETCH …
  BODY.PEEK` et `LOGOUT`.
- **Curseur** : un UID et l'`UIDVALIDITY`, gardés dans `app_settings` (`mailbox_imap_state`).
  Un passage ne demande que les UID au-delà du curseur ; il avance mail par mail, donc une panne
  au milieu ne perd rien et ne relit pas ce qui est passé. Premier passage : les 14 derniers jours.
  `UIDVALIDITY` changée (boîte reconstruite) : retour à la fenêtre de 14 jours, et le
  Message-ID évite tout doublon.
- **Lots** : 40 mails au plus par appel, 3 appels au plus par relève ; le reste au passage suivant.
- **Aucun mail perdu** : si le serveur ne rend pas tous les messages d'un lot, ceux qui manquent
  sont redemandés ; ceux qui existent encore sans être rendus font échouer le passage **sans
  avancer le curseur** (reprise au passage suivant) ; un message vraiment expulsé entre-temps est
  confirmé par un contrôle (`UID SEARCH UID …`) avant d'être sauté.
- **Idempotence** : un mail déjà connu (même Message-ID) est ignoré. Sans Message-ID, un
  identifiant stable est fabriqué à partir de l'UID.
- **Taille** : 512 Ko au plus par mail descendent (`BODY.PEEK[]<0.N>`). Au-delà, le début est
  gardé avec une mention « message volumineux ». Le texte stocké est plafonné à 20 000 caractères.

### Rattachement

Une seule fonction, `linkMail` (`src/services/message-link.ts`), pour la relève IMAP **et** la
réception Cloudflare Email Routing. Dans l'ordre : un **rattachement manuel du fil** (voir plus bas) ;
une **référence** de réservation dans le sujet ou le corps (`PM-2026-001`) ; le mail **répond à l'un
de nos messages** (`In-Reply-To` / `References` retrouvent le `Message-ID` de notre réponse, donc sa
réservation, même si le client écrit d'une autre adresse) ; un rattachement manuel déjà fait pour
**cette adresse**, tant que le client n'a pas de réservation active plus récente que celle choisie ;
sinon l'**adresse de l'expéditeur** est celle d'un client : sa réservation non annulée la plus proche
dans le temps (séjour en cours d'abord). Rien ne correspond : fil « sans réservation » (le fil se
regroupe alors par adresse, et ne reprend que les messages non rattachés de cette adresse).

**Fil = une réservation.** Le fil d'un message rattaché contient UNIQUEMENT les messages de cette
réservation (`booking_id = ?`), jamais ceux du même client sur une autre réservation ; celui d'un
message non rattaché, uniquement les messages sans réservation du même client ou de la même adresse.
Le voucher du client ne lit que `booking_id = sa réservation` : un message envoyé par le formulaire
public avec l'adresse d'une cliente (ou n'importe quel message « Autres ») n'y apparaît jamais. **Adresses de l'équipe et de la famille** : réglage global (`app_settings`, clé
`messagerie_team_addresses`, une adresse par ligne ; Réglages › Le domaine, `PUT
/api/admin/mailbox/team` avec `{ "addresses": "a@x.be\nb@y.be" }`, lecture dans
`GET /api/admin/mailbox` › `teamAddresses`). Un mail venant d'une de ces adresses n'est **jamais**
rattaché par son expéditeur (ni par l'adresse d'un client, ni par un rattachement manuel d'adresse) :
seulement par une référence explicite dans l'objet ou le corps, par un rattachement manuel du fil,
ou parce qu'il répond à un fil déjà rattaché. Défaut : vide.

**Rattacher / détacher à la main** : `PATCH /api/admin/messages/:id` avec `{ "bookingId": 123 }` ou
`{ "bookingId": null }` rattache ou détache **le fil affiché** (les messages entrants et sortants de la
même conversation, jamais l'historique du client sur une autre réservation), refuse un message de canal Beds24 (400) ou une réservation inconnue (404), et
écrit l'audit `message.attach` / `message.detach`. Le choix est marqué sur chaque message
(`messages.link_manual = 1`, migration 0041) et **prime ensuite** sur le rattachement automatique :
la réponse du client (`In-Reply-To`) et les mails suivants de la même adresse reprennent ce choix,
y compris « aucune réservation », au lieu de l'écraser. Un fil détaché perd aussi son client
(`guest_id`) : il sort de la fiche de la réservation et du voucher.

Le domaine (Pré Moré / Moulin de Braives) est celui de la
réservation, sinon celui dont l'adresse de contact est destinataire du mail.

### Pièces jointes

Listées (nom, taille) sous le message, **jamais stockées** en v1. Un fichier `.txt` en pièce
jointe n'est jamais pris pour le corps du mail.

## Répondre

Dans Messages, « Envoyer » sur un mail : envoi **SMTP** (`node/smtp.mjs`) depuis `MAIL_FROM`, avec
`In-Reply-To` (le Message-ID du client) et `References` (la chaîne, 20 identifiants au plus).

**Objet** : le champ « Objet » du fil est prérempli « Re: … » et modifiable avant « Envoyer » (corps
de la requête : `{ body, subject }`). Si le message est rattaché à une réservation dont la référence
(`PM-AAAA-NNN`) n'est pas déjà dans l'objet, le serveur l'ajoute d'office en tête : « [PM-2026-012]
Re: … ». L'objet ne contient jamais le nom d'une personne (`replySubject`, `src/services/email.ts` ; le
formulaire de contact écrit « [QU-…] Question — <domaine> », et les anciens « Question de <nom> » sont
réécrits à la réponse) ; la référence est cherchée sans tenir compte de la casse et sans sous-chaîne
(PM-2026-0123 n'est pas PM-2026-012) ; sauts de ligne, caractères de contrôle et bidi sont retirés,
200 caractères au plus ; objet vide : « [PM-…] Votre réservation ». Le message depuis la fiche d'une
réservation a le même champ « Objet » (`POST /api/admin/bookings/:id/messages` accepte `subject`).

**Signature** : voir la section dédiée plus bas. Elle est ajoutée à toute réponse (Messages) et à tout
message depuis une réservation, avant l'envoi ; le message gardé dans le fil reste sans signature. Le mail est journalisé dans `email_log` (genre `reply`, statut, identifiant SMTP), le
message sortant apparaît dans le fil (origine e-mail) et garde le Message-ID SMTP : la réponse du
client y retombe. Le message d'origine passe en « traité ».

Pour que la réponse parte de la même adresse que celle qui reçoit, régler SMTP sur Gmail
(`smtp.gmail.com`, port 587 — Hetzner bloque le 465 —, même adresse, même mot de passe d'application). Si SMTP reste sur
Infomaniak (`reservations@`), tout fonctionne, la réponse vient simplement de cette adresse.

Pas d'accusé de réception automatique sur ce chemin : seule une personne répond.

## Écran

- **Liste compacte** (colonne de gauche, 320 px) : **une ligne fine par fil** (la conversation, pas
  chaque mail ; groupement et pagination faits par le serveur, `GET /api/admin/messages/threads?section=resa|autres&status=nouveau|all&before=<id>&limit=50`,
  avec les compteurs « à répondre » de chaque onglet et les origines ; « Charger plus » pour les fils plus anciens, sans plafond de 200) : point « à répondre », nom en gras, pastille de la référence si rattaché, origine en
  abréviation (Mail, Site, Abnb, Bkg, Vrbo ; nom complet au survol), date courte à droite. Ni objet ni
  aperçu dans la ligne : l'objet est dans l'infobulle (`title`). Hauteur de ligne **44 px** (téléphone)
  et **40 px** (ordinateur) ; l'en-tête reste en place et seule la liste défile, la colonne ne pousse
  jamais la page (200 fils et plus sans problème).
- **Réservations / Autres** : deux onglets, chacun avec son compteur « à répondre » (en fils).
  « Réservations » = fils rattachés à une réservation ; « Autres » = non rattachés (Google, Drive,
  divers). Un fil « Autres » n'apparaît ni sur la fiche d'une réservation ni sur le voucher du client.
  « Rattacher à une réservation » (recherche par référence ou nom) et « Détacher » sont dans l'en-tête
  de chaque fil.
- **Ouvrir Gmail** : un seul petit lien en haut de l'écran, vers
  `https://mail.google.com/mail/u/?authuser=<adresse de la boîte>` (`IMAP_USER`, à défaut l'adresse de
  contact du domaine, rendue par `GET /api/admin/mailbox` › `address`), nouvel onglet, `noopener
  noreferrer`. Pas de lien par mail.
- **Liens du message** : voir Sécurité.
- **Filtre par origine** dans Messages (puces « E-mail (2) », « Airbnb (1) »… avec le nombre de
  messages à répondre), visible dès qu'il y a plus d'une origine.
- **Badge d'origine** sur chaque ligne, dans l'en-tête du fil et sur chaque bulle ; carte
  « Messages » et phrase du jour de la page Aujourd'hui : « 3 messages à lire (E-mail 2, Airbnb 1) ».
- **Marquer comme traité** / « Remettre à répondre » : le bouton sous le champ de réponse.
- État de la relève : `GET /api/admin/mailbox` ; relève immédiate : `POST /api/admin/mailbox/poll`.

## Sécurité

- Le contenu d'un mail n'est **jamais interprété** : le HTML est converti en texte (scripts,
  styles, commentaires retirés, entités décodées une seule fois), l'écran l'affiche comme du
  texte échappé par React.
- **Liens non cliquables d'office** : un lien HTML est écrit `texte (adresse complète)` dans le corps.
  Sous chaque mail reçu, la section **« Liens du message »** liste chaque lien : le **domaine réel en
  gras** (celui que le navigateur ouvrirait), l'adresse complète en petit, un bouton « Copier ».
  Extraction côté serveur à chaque lecture du fil (`src/core/links.ts`) : http et https seulement,
  dédoublonnés, 20 au plus, ponctuation de fin retirée, caractères bidi retirés. Un **redirecteur connu**
  (`google.com/url`, `l.facebook.com`, `safelinks.protection.outlook.com`…) affiche la cible réelle
  et « via <redirecteur> », sans « Ouvrir » ; `localhost`, adresses IP privées ou de boucle, `[::1]` et
  noms sans point ne sont jamais ouvrables. **« Ouvrir » n'existe que si** l'expéditeur
  est attesté par Gmail (`messages.sender_auth`, même critère `Authentication-Results` que
  l'anti-usurpation, lu avec soin : premier en-tête posé par google.com, commentaires et chaînes entre
  guillemets retirés, résultat découpé par « ; », il doit COMMENCER par `dmarc=pass` avec
  `header.from=` égal au domaine du From, ou `dkim=pass` signé par le domaine du From (`header.d` /
  `header.i`) ; un `dmarc=pass` écrit dans `smtp.mailfrom` ou un commentaire ne compte pas) **et** que le
  message n'est pas `spoofed` **et** que l'adresse ne cache pas d'identifiant devant le domaine
  (`user@`). L'ouverture passe par une confirmation qui répète le domaine réel, puis s'ouvre dans un
  nouvel onglet (`noopener noreferrer`). Un mail non attesté n'a jamais de bouton « Ouvrir », seulement
  « Copier ». Les mails relevés avant la migration 0041 n'ont pas d'attestation enregistrée : leurs
  liens ne se copient que.
- **Signature HTML** : saisie par l'administrateur, nettoyée à l'enregistrement par liste blanche
  (voir « Signature »), aperçue dans un cadre `sandbox` sans aucune permission.
- **Caractères de contrôle** retirés de l'objet, du nom et des adresses ; `In-Reply-To` et
  `References` ne gardent que des `<identifiants>` ; le client SMTP refuse tout identifiant de fil
  qui n'en serait pas un (pas d'injection d'en-tête, ex. un `Bcc:` caché dans un sujet).
- **Usurpation de l'adresse des gîtes** : un mail dont l'expéditeur est l'adresse de la boîte, de
  `MAIL_FROM` ou de l'adresse de contact d'un domaine sans que Gmail atteste l'expéditeur (premier en-tête
  `Authentication-Results` posé par Google : `dmarc=pass`, ou `dkim=pass` signé par le domaine de
  l'adresse annoncée, jamais par un autre domaine) est marqué, une alerte
  s'affiche et la réponse est bloquée (elle écrirait à l'adresse des gîtes). Même refus pour tout
  mail dont l'expéditeur est l'une des adresses des gîtes.
- Le mot de passe ne figure dans aucun message d'erreur ni journal ; la connexion refuse le clair
  (TLS dès la connexion) et `LOGINDISABLED`.
- Plafonds : ligne de réponse 1 Mo, littéral IMAP 1 Mo au plus (ou la taille demandée), 2 000
  réponses non étiquetées et un volume cumulé borné par commande, profondeur MIME 6, 50 pièces
  listées, délai global de 60 s.

## Variables

| Variable | Rôle |
|---|---|
| `IMAP_USER` | adresse de la boîte (`lesgitesdupremore@gmail.com`). **Sans elle, la relève est inactive.** |
| `IMAP_PASSWORD` | mot de passe d'application Google ; **retombe sur `SMTP_PASSWORD`** s'il est vide |
| `IMAP_HOST` | `imap.gmail.com` par défaut |
| `IMAP_PORT` | `993` par défaut (TLS direct, le seul mode accepté) |
| `MAILBOX_POLL_MINUTES` | filet entre deux passages du cron, 10 par défaut, 0 = au cron seulement |

Envoi des réponses : `EMAILS_ENABLED=true` et les variables SMTP habituelles (voir `.env.example`).

## Limites de la v1

- **Mot de passe d'application Google obligatoire** : validation en deux étapes sur le compte,
  puis un mot de passe d'application. Le mot de passe du compte ne fonctionne pas, et il n'y a pas
  d'OAuth.
- **Pas de pièces jointes stockées** : seulement leurs noms et tailles. Pour un fichier, il faut
  encore ouvrir Gmail (ou demander au client de l'envoyer autrement).
- **Pas de réponse avec pièce jointe**. Le texte enrichi n'existe que par la signature HTML : le corps
  tapé est du texte brut, converti en paragraphes et `<br>` simples dans la version HTML.
- **Pas d'ouverture de lien** pour les mails relevés avant la migration 0041 (attestation de
  l'expéditeur non enregistrée) : copier seulement.
- Le rattachement manuel d'une **adresse** (le choix fait sur un fil vaut pour les mails suivants de
  la même adresse) ne s'applique pas aux adresses de l'équipe et de la famille ; il se défait en
  rattachant ou détachant un fil de cette adresse.
- Le voucher n'affiche que les messages **de sa réservation** : un message du formulaire de contact
  écrit avant la réservation n'y est plus (il reste dans « Autres » tant qu'on ne l'a pas rattaché).
- **Cloudflare Workers** n'ouvre pas de socket sortante : la relève y est désactivée, avec un
  message clair (`GET /api/admin/mailbox`, ligne de journal `mailbox.imap.disabled`). Elle tourne
  sur le site Node (Infomaniak).
- Seule **INBOX** est lue (ni spam, ni libellés). Un mail archivé dans Gmail avant la relève, et
  plus ancien que 14 jours au premier passage, n'est pas repris.
- Les **notifications des canaux** (mails « Airbnb vous a envoyé un message ») qui arriveraient
  dans la boîte apparaissent comme des mails ordinaires : elles doublonnent le message que Beds24
  apporte déjà. À filtrer côté Gmail (ne pas les envoyer vers cette boîte) plutôt qu'ici.
- L'authentification de l'expéditeur ne se lit que pour Gmail (`google.com`) ; avec un autre
  fournisseur IMAP, tout mail portant l'adresse des gîtes est signalé.
- Un mail illisible reste visible sous « (message illisible) » plutôt que de disparaître.

## Essai sur une boîte non dédiée (IMAP_FOLDER)

La relève lit `INBOX` par défaut. Sur une adresse personnelle, elle ferait remonter tous les mails privés. On limite alors la relève à un libellé Gmail :

1. Dans Gmail, créer un filtre « À : `adresse+gites@gmail.com` » → appliquer le libellé `Gites`, cocher « Ignorer la boîte de réception ».
2. Dans le `.env` : `IMAP_FOLDER=Gites` (sans accent), avec `IMAP_USER` et le mot de passe d'application de cette adresse.
3. Au démarrage, le journal affiche « dossier Gites ». Changer de dossier ou de boîte remet le curseur à zéro (UIDVALIDITY différente) : les 14 derniers jours du nouveau dossier sont relus.

## Signature

Réglages › Le domaine › « Signature des messages » (par domaine, table `settings`) :

| Réglage (clé `settings`) | Champ de l'écran | Rôle |
|---|---|---|
| `signature_text` | Signature (texte) | texte brut, 2 000 caractères au plus ; valeur de la variable `{signature}` des modèles quand elle est remplie (sinon le nom du domaine) |
| `signature_html` | Signature (HTML) | HTML, 20 000 caractères au plus, **nettoyé à l'enregistrement** |
| `signature_on_replies` | Ajouter la signature aux réponses et messages | `true` / `false`, défaut `false` |

Écriture : `PUT /api/admin/settings?property=<id>` avec `{ "settings": { "signature_text": "…",
"signature_html": "…", "signature_on_replies": true } }` ; lecture : `GET /api/admin/settings` ›
`signatureText`, `signatureHtml`, `signatureOnReplies`.

**Envoi** (`composeOutgoing`, `src/core/signature.ts`, appelé par `sendTeamReply` pour la réponse de
Messages et pour le message depuis une réservation) : quand la case est cochée et qu'une signature
existe,

- partie **texte** = corps + `"\n\n-- \n"` + signature texte ;
- si une signature HTML existe, le mail devient **multipart/alternative** (texte puis HTML,
  `node/smtp.mjs`, quoted-printable UTF-8, lignes de 76 caractères au plus) : le corps tapé est
  échappé et converti (paragraphes à la ligne vide, `<br>` au saut de ligne), suivi de la signature
  HTML ; une image écrite `/img/…` est réécrite en URL absolue avec `PUBLIC_BASE_URL`, et **retirée**
  si cette adresse est absente ou locale (le serveur Node avertit au démarrage) ;
- jamais deux fois : si le corps FINIT déjà par la signature texte (un modèle qui se termine par
  `{signature}`, comparaison ligne à ligne), le texte part tel quel et la partie HTML reçoit le corps
  sans cette signature suivi de la signature HTML ; une signature courte au milieu d'une phrase
  (« Julien vous rappellera ») n'empêche rien ;
- le message gardé dans le fil et `messages.body_text` restent **sans** signature ; `email_log`
  garde le texte réellement envoyé.

La signature texte du domaine signe aussi le lien de paiement et le rappel de solde (FR et NL). La
variable `{signature}` des modèles de réponse (écran) et des mails automatiques (confirmation,
annulation, relance d'abandon) prend la signature texte si elle est remplie, sinon le nom du domaine.

**Nettoyage du HTML** (`sanitizeSignatureHtml`) : le HTML est reconstruit balise par balise. Balises
permises : `table`, `tbody`, `thead`, `tr`, `td`, `th`, `div`, `span`, `p`, `br`, `a`, `img`, `b`, `i`,
`strong`, `em`. `script`, `style`, `iframe`, `form`, `object`, `svg`… disparaissent **avec leur
contenu** ; toute autre balise disparaît, son texte reste. Attributs : `style` (liste blanche de
propriétés : couleur, police, taille, marges, bordures, dimensions, alignement, arrondi, `display`
limité à block/inline/table…, `object-fit` ; tout le reste, dont `background-image`, `position`,
`content`, `filter`, et toute valeur avec `url()`, `image-set`, `data:`, `expression`, `@`, `\`, est retiré), quelques attributs de mise en page
(`width`, `height`, `colspan`, `align`, `cellpadding`…), `href` (http, https, `mailto:`, `tel:`
seulement ; `rel="noopener noreferrer"` ajouté), `src` d'image (https, ou chemin du site `/img/…`),
`alt`. Tout attribut `on*` et tout `javascript:` / `data:` est retiré.

Exemple de départ (à coller dans « Signature (HTML) » ; l'image est dans `public/img/signature-pre-more.jpg`) :

```html
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:520px">
 <tr>
  <td style="padding:0 16px 0 0;vertical-align:top;width:96px">
   <img src="/img/signature-pre-more.jpg" width="96" height="96" alt="Les Gîtes du Pré Moré, au bord du Ry des Glands" style="display:block;width:96px;height:96px;border-radius:10px;object-fit:cover;border:0">
  </td>
  <td style="vertical-align:top;border-left:3px solid #2F5D3F;padding:2px 0 2px 14px">
   <div style="font:600 17px/1.3 Georgia,'Times New Roman',serif;color:#22301F">Jean-Philippe de Cartier d'Yves</div>
   <div style="font:italic 14px/1.4 Georgia,'Times New Roman',serif;color:#2F5D3F;margin:1px 0 8px">Les Gîtes du Pré Moré — gîtes ruraux en Ardenne</div>
   <div style="font:13px/1.55 -apple-system,'Segoe UI',Arial,sans-serif;color:#4B5563">
    Hameau du Pré Moré, 6890 Redu<br>
    <a href="tel:+32498440883" style="color:#22301F;text-decoration:none">0498 44 08 83</a> ·
    <a href="mailto:jphde.cartier@gmail.com" style="color:#22301F;text-decoration:none">jphde.cartier@gmail.com</a><br>
    <a href="https://178-105-145-191.sslip.io/reserver/pre-more/" style="color:#2F5D3F;font-weight:600;text-decoration:none">Réserver en ligne →</a>
   </div>
   <div style="font:italic 12.5px/1.4 Georgia,'Times New Roman',serif;color:#8A7F63;margin-top:8px">Éteignez les écrans. Allumez le feu.</div>
  </td>
 </tr>
 <tr><td colspan="2" style="padding-top:12px;font:11px/1.45 -apple-system,'Segoe UI',Arial,sans-serif;color:#9CA3AF">
  Exploitant : Jean-Philippe de Cartier d'Yves, Rue des Barbouillons 12, 6929 Daverdisse (Belgique) · Gîtes PANDA (WWF)
 </td></tr>
</table>
```

Et la version texte (« Signature (texte) ») :

```text
Jean-Philippe de Cartier d'Yves
Les Gîtes du Pré Moré — gîtes ruraux en Ardenne
Hameau du Pré Moré, 6890 Redu
0498 44 08 83 · jphde.cartier@gmail.com
Réserver en ligne : https://178-105-145-191.sslip.io/reserver/pre-more/
Exploitant : Jean-Philippe de Cartier d'Yves, Rue des Barbouillons 12, 6929 Daverdisse (Belgique)
```

Ce modèle n'est **pas** en base : il se pose depuis l'écran, après validation.
