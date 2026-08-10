#!/bin/bash
# Sauvegarde hebdomadaire de la base de production (issue #7).
#
# Les migrations ne sont PAS une sauvegarde : les rejouer reconstruit un système
# vide, jamais les réservations. Time Travel couvre « j'ai fait une bêtise
# mardi » et rien d'autre — ni la perte du compte Cloudflare, ni une corruption
# découverte trois semaines plus tard.
#
# Ce script ne fait que LIRE la production (wrangler d1 export). Il n'écrit
# jamais vers Cloudflare.
#
# Usage :
#   scripts/backup-d1.sh              # sauvegarde du jour + rotation
#   SAUVEGARDES_A_GARDER=12 scripts/backup-d1.sh
#
# Prévu pour tourner sans terminal (LaunchAgent) : tout est journalisé dans
# sauvegardes/journal-sauvegardes.log, et le code de sortie est non nul en cas
# d'échec.

set -euo pipefail

# Le script doit fonctionner quel que soit le répertoire courant : launchd
# démarre les tâches à la racine du disque, pas dans le projet.
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RACINE"

BASE="gites-platform"
DOSSIER="sauvegardes"
JOURNAL="$DOSSIER/journal-sauvegardes.log"
A_GARDER="${SAUVEGARDES_A_GARDER:-8}"
HORODATAGE="$(date +%F)"
CIBLE="$DOSSIER/${HORODATAGE}-${BASE}.sql"

mkdir -p "$DOSSIER"

dire() {
  echo "[$(date '+%F %T')] $*" | tee -a "$JOURNAL"
}

echouer() {
  dire "ÉCHEC : $*"
  exit 1
}

dire "--- Sauvegarde de $BASE ---"

command -v npx >/dev/null 2>&1 || echouer "npx introuvable. Sous launchd, le PATH est minimal : renseigner PATH dans le plist."

# Export vers un fichier temporaire, déplacé en place SEULEMENT en cas de
# succès. Sans cette précaution, un export interrompu laisserait un fichier
# tronqué portant la date du jour — et la rotation finirait par supprimer les
# vraies sauvegardes en le prenant pour l'une d'elles.
TEMPORAIRE="$(mktemp "${DOSSIER}/.export-XXXXXX.sql")"
nettoyer() { rm -f "$TEMPORAIRE"; }
trap nettoyer EXIT

dire "Export de la base distante (lecture seule)…"
# Pas de --env production : le bloc racine cible déjà la bonne base, et l'env
# nommé provoque une erreur d'autorisation 7403 sur ce compte.
if ! npx wrangler d1 export "$BASE" --remote --output "$TEMPORAIRE" >>"$JOURNAL" 2>&1; then
  echouer "wrangler d1 export a échoué — voir $JOURNAL."
fi

# Un export « réussi » mais vide est le pire des cas : il inspire confiance et
# ne contient rien. On refuse tout ce qui n'a pas au moins un schéma.
[ -s "$TEMPORAIRE" ] || echouer "l'export est vide."
grep -q "CREATE TABLE" "$TEMPORAIRE" || echouer "l'export ne contient aucune table — fichier suspect, conservé nulle part."

OCTETS="$(wc -c <"$TEMPORAIRE" | tr -d ' ')"
mv "$TEMPORAIRE" "$CIBLE"
trap - EXIT
dire "Sauvegarde écrite : $CIBLE ($OCTETS octets)"

# Rotation : on garde les N plus récentes, on supprime le reste. Le tri porte
# sur le nom, dont le préfixe est une date ISO — l'ordre alphabétique est donc
# l'ordre chronologique.
# NB : boucle `while read` et non `mapfile`, absent du bash 3.2 livré par macOS,
# qui est précisément le shell qui exécutera ce script.
SUPPRIMEES=0
while IFS= read -r vieille; do
  [ -n "$vieille" ] || continue
  rm -f "$vieille"
  SUPPRIMEES=$((SUPPRIMEES + 1))
  dire "Rotation : $(basename "$vieille") supprimée (on garde les $A_GARDER dernières)."
done <<EOF
$(ls -1 "$DOSSIER"/*-"${BASE}".sql 2>/dev/null | sort -r | tail -n +"$((A_GARDER + 1))")
EOF

if [ "$SUPPRIMEES" -eq 0 ]; then
  dire "Rotation : rien à supprimer (au plus $A_GARDER sauvegardes conservées)."
fi

dire "--- Terminé ---"
