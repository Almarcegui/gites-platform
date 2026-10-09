#!/opt/homebrew/bin/python3
# Livraison de la plateforme (make livrer : production ; make livrer-essai : essai) sous un verrou par cible : gardes, sauvegarde, migrations distantes, déploiement, sonde.
# Usage : /opt/homebrew/bin/python3 scripts/livrer.py --cible prod|essai   ·   /opt/homebrew/bin/python3 scripts/livrer.py --sonde prod|essai
"""Livraison de la plateforme des gîtes, production ou essai.

La chaîne, dans cet ordre, et elle s'arrête à la première étape en échec :
1. gardes : arbre propre ; `make check` vert sur ce commit (marque
   .wrangler/check-ok = HEAD) ; production : branche main seulement ; wrangler
   du dépôt présent (node_modules/.bin, jamais un wrangler global ni un
   téléchargement implicite) ; essai : .secrets.essai présent ;
2. verrou par cible, tenu jusqu'au bout (deux livraisons vers la même base ne
   s'entrelacent pas, même depuis deux worktrees) ;
3. sauvegarde de la base (scripts/sauvegarde_nuit.py) : sans elle, rien ne migre ;
4. migrations distantes ;
5. déploiement (HEAD revérifié juste avant) ;
6. sonde publique /api/public/health : statut 2xx et JSON dont `ok` vaut true.

Rien ne part en production sans le « go » de Julien (COLLABORATION.md).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
PYTHON = "/opt/homebrew/bin/python3"
WRANGLER = RACINE / "node_modules" / ".bin" / "wrangler"
MARQUE_CHECK = RACINE / ".wrangler" / "check-ok"
SECRETS_ESSAI = RACINE / ".secrets.essai"
URLS = {
    "prod": "https://gites-platform.j-decartier.workers.dev",
    "essai": "https://gites-platform-essai.j-decartier.workers.dev",
}


class Refus(Exception):
    pass


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=RACINE, capture_output=True, text=True)
    if r.returncode != 0:
        raise Refus(f"git {' '.join(args)} a échoué : {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def etape(titre: str, commande: list[str]) -> None:
    print(f"\n── {titre} : {' '.join(commande)}", flush=True)
    r = subprocess.run(commande, cwd=RACINE)
    if r.returncode != 0:
        raise Refus(f"{titre} en échec (code {r.returncode}) : la livraison s'arrête là.")


def gardes(cible: str) -> str:
    if git("status", "--porcelain"):
        raise Refus("l'arbre n'est pas propre (git status) : on ne livre que ce qui est committé.")
    head = git("rev-parse", "HEAD")
    marque = MARQUE_CHECK.read_text().strip() if MARQUE_CHECK.is_file() else ""
    if not head or marque != head:
        raise Refus(f"make check n'est pas passé sur ce commit ({head[:8]}) : lancer make check, seul, puis relivrer.")
    if cible == "prod":
        branche = git("rev-parse", "--abbrev-ref", "HEAD")
        if branche != "main":
            raise Refus(f"la production ne se livre que depuis main (branche actuelle : {branche}).")
    if not WRANGLER.exists():
        raise Refus("node_modules/.bin/wrangler absent : make installer d'abord.")
    if cible == "essai" and not SECRETS_ESSAI.is_file():
        raise Refus(".secrets.essai manque (ADMIN_TOKEN d'essai ; il vit dans le clone principal, à recopier ici).")
    return head


def verrou_de(cible: str):
    """Verrou dans le clone principal : partagé par tous les worktrees."""
    commun = Path(git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    dossier = commun.parent / "sauvegardes"
    dossier.mkdir(mode=0o700, exist_ok=True)
    f = (dossier / f".livraison-{cible}.verrou").open("w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as e:
        f.close()
        raise Refus(f"une autre livraison vers {cible} tourne déjà.") from e
    return f


def sonder(cible: str, essais: int = 12, pause_s: float = 5.0) -> None:
    url = URLS[cible] + "/api/public/health"
    dernier = "rien"
    for _ in range(essais):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "gites-livrer"}), timeout=10) as r:
                corps = r.read(4096).decode("utf-8", "replace")
                if 200 <= r.status < 300:
                    donnees = json.loads(corps)
                    if isinstance(donnees, dict) and donnees.get("ok") is True:
                        print(f"Sonde verte : {url} -> {corps}")
                        return
                dernier = f"HTTP {r.status} {corps[:200]}"
        except urllib.error.HTTPError as e:
            dernier = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError, ValueError) as e:
            dernier = f"{type(e).__name__}: {e}"
        time.sleep(pause_s)
    raise Refus(f"sonde ROUGE : {url} ne répond pas ok après une minute (dernier : {dernier}).")


def livrer(cible: str) -> None:
    head = gardes(cible)
    verrou = verrou_de(cible)
    try:
        sauvegarde = [PYTHON, str(RACINE / "scripts" / "sauvegarde_nuit.py"), "--cible", cible, "--origine", "livraison"]
        if cible == "essai":
            sauvegarde.append("--base-vide-admise")  # première livraison : la base d'essai n'a encore aucune table
        etape("Sauvegarde", sauvegarde)
        if cible == "prod":
            etape("Migrations distantes", ["npm", "run", "-s", "db:migrate:remote"])
        else:
            etape("Migrations distantes", [str(WRANGLER), "d1", "migrations", "apply", "gites-platform-essai", "--remote", "--env", "essai"])
        if git("rev-parse", "HEAD") != head or git("status", "--porcelain"):
            raise Refus("l'arbre a changé pendant la livraison : déploiement annulé (les migrations sont passées, la sauvegarde est faite).")
        if cible == "prod":
            etape("Déploiement", [str(WRANGLER), "deploy", "--env", "production"])
        else:
            etape("Déploiement", [str(WRANGLER), "deploy", "--env", "essai", "--secrets-file", str(SECRETS_ESSAI)])
        sonder(cible)
        print(f"\nLivré : {head[:8]} sur {cible} ({URLS[cible]}).")
    finally:
        verrou.close()


def main() -> int:
    p = argparse.ArgumentParser(description="Livraison de la plateforme des gîtes.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--cible", choices=sorted(URLS))
    g.add_argument("--sonde", choices=sorted(URLS))
    a = p.parse_args()
    try:
        if a.sonde:
            sonder(a.sonde)
        else:
            livrer(a.cible)
    except Refus as e:
        print(f"Refusé : {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
