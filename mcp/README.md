# Connecteur Claude (MCP) de la plateforme Gîtes

Serveur MCP **local** (transport stdio) qui permet de piloter la plateforme depuis
Claude Code, Claude Desktop ou Jarvis : « qui arrive ce week-end ? », « la Scierie
est-elle libre du 12 au 15 ? », « bloque la Scierie du 12 au 15 », « réponds au
client », « fais un devis pour 6 personnes », « où en sont les paiements ? ».

Il ne parle **qu'à l'API HTTP existante** (`/api/admin/*`, plus la sonde publique
`/api/public/health`) : aucune base, aucune règle métier en double. Le prix, la
disponibilité, les liaisons entre logements et les refus restent ceux du Worker.

## Outils

| Outil | Rôle |
|---|---|
| `arrivees_departs` | Arrivées et départs d'une période (`aujourdhui`, `demain`, `ce_week_end` = vendredi → lundi, `week_end_prochain`, `7_jours`, `30_jours`, ou `du`/`au`). |
| `disponibilite` | Libre ou occupé entre deux dates, liaisons et blocages compris ; règles de séjour signalées. Sans hébergement : tous. |
| `devis` | Prix du moteur tarifaire (arrhes, solde, échéance, caution) et disponibilité. Sans hébergement : tous ceux qui accueillent le groupe. |
| `fiche_reservation` | Fiche complète par référence (`PM-2026-004`) ou id. |
| `reservations` | Liste filtrée (période, statut, recherche, dates). |
| `messages_en_attente` | Messages clients non traités ; avec `message_id`, le fil complet. |
| `paiements_en_attente` | Soldes dus, retards en tête. |
| `sante` | Plateforme en ligne, cron, et carte Santé de chaque domaine. |
| `bloquer_dates` ✎ | Blocage manuel (travaux, usage perso), liaisons comprises. |
| `debloquer_dates` ✎ | Lève un blocage manuel. |
| `repondre_client` ✎ | Répond à un message reçu, ou écrit au client d'une réservation. |
| `vente_telephone` ✎ | Crée une réservation (confirmée ou en option), lien Stripe en option. |
| `relancer_solde` ✎ | E-mail de rappel du solde au client. |

✎ = écriture. **Toute écriture se fait en deux appels** : le premier (sans
`confirmer`) ne touche à rien et renvoie un récapitulatif et un jeton ; le second,
avec **exactement les mêmes paramètres**, `confirmer: true` et ce jeton, écrit.

Garde-fous du second appel :

- **validation humaine par l'hôte** : par défaut (`GITES_MCP_CONFIRMATION=hote`),
  l'écriture n'a lieu que si l'hôte affiche le récapitulatif à l'utilisateur dans une
  boîte de dialogue et qu'il accepte (**élicitation MCP** — Claude Code la gère). Le
  modèle seul ne peut donc pas dire oui. Un hôte qui ne sait pas le faire voit ses
  écritures refusées ;
- `GITES_MCP_CONFIRMATION=jeton` se contente du double appel : à réserver à un hôte qui
  fait lui-même approuver **chaque** appel d'écriture par l'humain (Jarvis et sa
  confirmation vocale ; Claude Desktop sans élicitation, écritures jamais
  auto-approuvées) ;
- le jeton est à usage unique, valable 10 minutes, et **un seul jeton vit par outil** :
  un nouveau récapitulatif révoque le précédent (pas de double envoi) ;
- il est lié aux paramètres : une date ou un mot changé l'invalide ;
- le récapitulatif est **recalculé** avant la validation et encore juste avant
  d'écrire ; si quoi que ce soit de ce qui a été montré a bougé (prix, cible,
  destinataire, dates, échéance, disponibilité), rien n'est écrit et le nouvel état
  est montré ;
- une coupure réseau, une réponse illisible ou de forme inattendue, une erreur 5xx
  pendant l'écriture est annoncée comme « état inconnu » — jamais « rien n'a été
  écrit » ; la même demande est ensuite refusée 30 minutes tant qu'on n'a pas vérifié
  au back-office et ajouté `apres_verification: true`.

### Ce que le connecteur ne fait pas (volontairement)

- **Annuler une réservation, rembourser, modifier un paiement** : back-office
  uniquement. Une annulation engage les arrhes et les CGV, un remboursement se
  traite dans Stripe — ce sont des gestes qu'on fait en regardant l'écran.
- Modifier les tarifs, saisons, promotions, utilisateurs, canaux.
- Modifier une réservation existante (dates, logement) : back-office.
- Envoyer le voucher : `vente_telephone` n'envoie aucun e-mail au client.

## Installation

```bash
cd mcp
npm ci
npm run build        # produit dist/index.js
npm test             # 39 tests contre un faux serveur HTTP
```

Node 20 ou plus récent.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `GITES_URL` | `https://gites-platform.j-decartier.workers.dev` (prod) ou `http://localhost:8788` (dev). Une origine seule (ni chemin, ni identifiant, ni requête) ; `http://` n'est accepté que pour localhost. |
| `GITES_ID` | Identifiant admin : un compte de la page Utilisateurs (session de 30 jours, renouvelée seule), ou un couple de secours de `ADMIN_TOKEN`. |
| `GITES_MDP` | Son mot de passe. |
| `GITES_SERVICE_KEY` | À la place de `GITES_ID`/`GITES_MDP` : une **clé d'accès de service** (back-office, page Utilisateurs › Accès de service, affichée une fois). Présentée en `Bearer svc:<clé>`, sans connexion ; le journal d'audit l'inscrit `svc:<nom>`. Révoquée : le connecteur reçoit 401 et ne réessaie pas. Pratique pour Claude et Jarvis, qui n'ont pas de compte humain. |
| `GITES_MDP_TROUSSEAU` | À la place de `GITES_MDP` : nom d'un service du trousseau macOS (compte = `GITES_ID`). Évite le mot de passe en clair dans un fichier de configuration. |
| `GITES_TIMEOUT_MS` | Délai par requête (défaut 20 000). |
| `GITES_MCP_SILENCE` | `1` = aucun journal sur stderr. |
| `GITES_MCP_CONFIRMATION` | `hote` (défaut) : écriture seulement après validation dans la boîte de dialogue de l'hôte ; `jeton` : double appel seul (voir plus haut). |
| `GITES_MCP_ELICITATION` | `0` = ne jamais ouvrir la boîte de dialogue (avec `hote`, toute écriture est alors refusée). |

Ranger le mot de passe dans le trousseau (une fois) :

```bash
security add-generic-password -s gites-platform -a julien -w   # le demande sans l'afficher
```

**Un compte par personne** (Julien, son père, Jarvis) : créer chaque compte dans
le back-office, page Utilisateurs. Le journal d'audit de la plateforme dira alors
qui a fait quoi, et un compte se révoque sans toucher aux autres.

## Claude Code — `.mcp.json`

À la racine du projet (ou du vault) d'où l'on lance Claude Code :

```json
{
  "mcpServers": {
    "gites": {
      "command": "node",
      "args": ["/Users/almarcegui/Documents/ClaudeVault/🔧 Dev/Gites Platform/mcp/dist/index.js"],
      "env": {
        "GITES_URL": "https://gites-platform.j-decartier.workers.dev",
        "GITES_ID": "julien",
        "GITES_MDP_TROUSSEAU": "gites-platform"
      }
    }
  }
}
```

Les outils apparaissent sous `mcp__gites__<outil>`. Pour ne pas être interrogé à
chaque lecture, autoriser d'office les huit outils de lecture dans
`.claude/settings.json` (`"permissions": {"allow": ["mcp__gites__arrivees_departs", …]}`)
et laisser les cinq écritures soumises à approbation.

## Claude Desktop — `claude_desktop_config.json`

`~/Library/Application Support/Claude/claude_desktop_config.json`. Claude Desktop
ne charge pas le `PATH` du terminal : donner le chemin complet de `node`
(`which node`, en général `/opt/homebrew/bin/node`).

```json
{
  "mcpServers": {
    "gites": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/almarcegui/Documents/ClaudeVault/🔧 Dev/Gites Platform/mcp/dist/index.js"],
      "env": {
        "GITES_URL": "https://gites-platform.j-decartier.workers.dev",
        "GITES_ID": "papa",
        "GITES_MDP_TROUSSEAU": "gites-platform"
      }
    }
  }
}
```

Redémarrer Claude Desktop après modification.

## Jarvis

Jarvis passe par le SDK Agent de Claude avec les réglages du vault : il voit donc
le serveur `gites` dès qu'il figure dans le `.mcp.json` du vault. Il reste à
pré-autoriser les lectures et à faire confirmer les écritures à voix haute —
exemple dans [`exemples/jarvis.py`](exemples/jarvis.py). Si les écritures de Jarvis
sont refusées faute d'élicitation, lui déclarer sa propre entrée avec
`GITES_MCP_CONFIRMATION=jeton` (sa confirmation vocale tient lieu de validation).

## Journal et données personnelles

Le connecteur écrit sur **stderr** (stdout porte le protocole) : nom de l'outil,
issue, route HTTP sans paramètres, code de retour, durée. **Jamais** de nom, d'e-mail,
de texte de message, de référence de réservation, de mot de passe ni de jeton de
session. Un test le vérifie. Les réponses des outils, elles, contiennent les données
nécessaires à la tâche (nom du client, e-mail) : elles vont au modèle qui a posé la
question, pas dans un fichier.

## Limites

- Les options payantes (`options` du devis) ne sont pas exposées : le devis et la
  vente se font sans option ; les ajouter au back-office si besoin.
- `paiements_en_attente` regarde les séjours terminés depuis moins de 90 jours.
- Le référentiel (domaines, hébergements, liaisons) est gardé 5 minutes en mémoire.
- Une coupure réseau pendant une écriture est signalée comme « état inconnu » : le
  connecteur ne rejoue jamais une écriture tout seul ; vérifier au back-office.
- Le connecteur fait confiance au Worker pour l'atomicité : le récapitulatif annonce,
  l'écriture tranche (un créneau pris entre-temps est refusé avec son motif).
- Fenêtre résiduelle : entre le recalcul du récapitulatif et l'écriture (quelques
  millisecondes), le Worker recalcule lui-même le prix et ne vérifie ni la capacité
  ni le statut actif de l'hébergement ; voir « À prévoir côté Worker ».
- `vente_telephone` : le Worker enregistre la fiche client avant de tenter la
  réservation ; un refus (créneau pris) peut donc laisser une fiche client créée
  ou mise à jour.

## À prévoir côté Worker (non fait ici)

1. `POST /api/admin/bookings` : accepter un `expectedTotalCents` (et refuser 409 si
   le devis recalculé diffère), vérifier `capacity_max` et `active`, et créer ou
   mettre à jour le client dans la même transaction que la réservation.
2. Clé d'idempotence (`Idempotency-Key`) sur les routes d'écriture (blocages, vente,
   messages, relance) pour qu'un nouvel essai après coupure ne double rien (le
   connecteur ne fait que freiner : refus 30 minutes sans `apres_verification`).
3. Préconditions vérifiées dans la même transaction que l'écriture (destinataire et
   solde attendus pour la relance, version de la réservation) : le recalcul du
   connecteur laisse une fenêtre de quelques millisecondes.
4. `GET /api/admin/blocks/:id` (aujourd'hui, retrouver un blocage passe par la liste).

## Développement

```
src/index.ts            point d'entrée stdio
src/server.ts           assemblage (testable en mémoire)
src/client.ts           HTTP, connexion, renouvellement de session
src/referentiel.ts      noms → ids (« Scierie » ≠ « Maison du Scieur »)
src/confirmation.ts     jetons du double geste
src/outils-lecture.ts   8 outils de lecture
src/outils-ecriture.ts  5 outils d'écriture
test/faux-serveur.ts    faux Worker (vrai HTTP)
test/connecteur.test.ts protocole MCP de bout en bout via InMemoryTransport
```

Essai contre le Worker local : `npm run dev` à la racine (port 8788), puis
`GITES_URL=http://localhost:8788 GITES_ID=… GITES_MDP=… npx @modelcontextprotocol/inspector node dist/index.js`.
