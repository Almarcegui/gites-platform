#!/opt/homebrew/bin/python3
# Livraison de la plateforme sous un verrou par cible — make livrer : production Infomaniak (gardes, sauvegarde, push de main, geste Manager, sonde) ; make livrer-cloudflare / livrer-essai : Workers (gardes, sauvegarde, migrations distantes, wrangler deploy, sonde).
# Usage : /opt/homebrew/bin/python3 scripts/livrer.py --cible prod|cloudflare|essai [--sans-sauvegarde]   ·   /opt/homebrew/bin/python3 scripts/livrer.py --sonde prod|cloudflare|essai
"""Livraison de la plateforme des gîtes.

**Production = le site Node.js chez Infomaniak** (https://dev1.mdcdy.be,
décision de Julien du 10/10/2026) : le serveur est un clone de `main` du dépôt
GitHub, et se redéploie quand on le redémarre dans le Manager Infomaniak. Il
applique lui-même les migrations au démarrage (node/migrate.mjs). Nous n'avons
pas d'accès SSH. `make livrer` fait donc, dans cet ordre :
1. gardes : arbre propre ; `make check` vert sur ce commit (marque
   .wrangler/check-ok = HEAD) ; branche main ; `origin/main` est un ancêtre de
   HEAD (rien à écraser, jamais de push forcé) ;
2. verrou de la cible ;
3. sauvegarde de la base de production (scripts/sauvegarde_nuit.py --cible
   infomaniak, compte « sauvegarde ») : sans elle, rien ne part — sauf
   `--sans-sauvegarde` (SANS_SAUVEGARDE=oui), le temps que le compte existe ;
4. `git push origin main` (si HEAD n'y est pas déjà) ;
5. le geste de Julien, rappelé : redémarrer le site dans le Manager ;
   on attend Entrée (refus sans terminal : la sonde verrait l'ancienne version) ;
6. sonde publique /api/public/health (statut 2xx, `ok` vaut true, une minute),
   puis scripts/gites_sonde.py : traitement planifié rouge = sortie en échec.

`make livrer-cloudflare` (l'ancien Worker, tant qu'il existe) et
`make livrer-essai` gardent la chaîne Workers :
1. gardes : arbre propre ; `make check` vert sur ce commit (marque
   .wrangler/check-ok = HEAD) ; production : branche main seulement ; wrangler
   du dépôt présent (node_modules/.bin, jamais un wrangler global ni un
   téléchargement implicite) ; essai : .secrets.essai présent ;
2. verrou par cible, tenu jusqu'au bout (deux livraisons vers la même base ne
   s'entrelacent pas, même depuis deux worktrees) ; essai : aucun secret autre
   qu'ADMIN_TOKEN (et Turnstile), ni dans .secrets.essai ni sur le Worker ;
3. sauvegarde de la base (scripts/sauvegarde_nuit.py) : sans elle, rien ne migre ;
4. migrations distantes ;
5. déploiement (HEAD et arbre propre revérifiés avant les migrations et avant
   le déploiement ; pas d'instantané figé : un seul opérateur, sous verrou) ;
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
    "prod": "https://dev1.mdcdy.be",
    "cloudflare": "https://gites-platform.j-decartier.workers.dev",
    "essai": "https://gites-platform-essai.j-decartier.workers.dev",
}
MANAGER = "https://manager.infomaniak.com"


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
    if cible in ("prod", "cloudflare"):
        branche = git("rev-parse", "--abbrev-ref", "HEAD")
        if branche != "main":
            raise Refus(f"la production ne se livre que depuis main (branche actuelle : {branche}).")
    if cible == "prod":
        git("fetch", "--quiet", "origin", "main")
        distant = git("rev-parse", "origin/main")
        r = subprocess.run(["git", "merge-base", "--is-ancestor", distant, head], cwd=RACINE)
        if r.returncode != 0:
            raise Refus(f"origin/main ({distant[:8]}) n'est pas un ancêtre de HEAD ({head[:8]}) : "
                        "git pull d'abord (jamais de push forcé).")
    elif not WRANGLER.exists():
        raise Refus("node_modules/.bin/wrangler absent : make installer d'abord.")
    if cible == "essai" and not SECRETS_ESSAI.is_file():
        raise Refus(".secrets.essai manque (ADMIN_TOKEN d'essai ; il vit dans le clone principal, à recopier ici).")
    return head


# L'essai ne doit porter aucun secret de service réel : en https, BEDS24_WRITE_ENABLED=false
# ne suffit pas (src/services/beds24.ts), et `--secrets-file` ajoute sans jamais retirer.
SECRETS_ADMIS_ESSAI = {"ADMIN_TOKEN", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"}


def verifier_secrets_essai() -> None:
    cles = set()
    for ligne in SECRETS_ESSAI.read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if ligne and not ligne.startswith("#"):
            cles.add(ligne.split("=", 1)[0].strip())
    if "ADMIN_TOKEN" not in cles:
        raise Refus(".secrets.essai ne porte pas d'ADMIN_TOKEN.")
    if cles - SECRETS_ADMIS_ESSAI:
        raise Refus(f".secrets.essai porte des secrets interdits sur l'essai : {', '.join(sorted(cles - SECRETS_ADMIS_ESSAI))}.")
    r = subprocess.run([str(WRANGLER), "secret", "list", "--env", "essai", "--format", "json"],
                       cwd=RACINE, capture_output=True, text=True)
    if r.returncode != 0:
        # Premier déploiement : le Worker d'essai n'existe pas encore, il n'a donc aucun secret.
        print("(liste des secrets de l'essai indisponible : Worker pas encore créé ?)", flush=True)
        return
    try:
        distants = {s["name"] for s in json.loads(r.stdout)}
    except (ValueError, KeyError, TypeError) as e:
        raise Refus("liste des secrets de l'essai illisible : déploiement refusé.") from e
    if distants - SECRETS_ADMIS_ESSAI:
        raise Refus(f"le Worker d'essai porte des secrets interdits : {', '.join(sorted(distants - SECRETS_ADMIS_ESSAI))} "
                    "(à retirer : wrangler secret delete <NOM> --env essai).")


def meme_arbre(head: str) -> None:
    if git("rev-parse", "HEAD") != head or git("status", "--porcelain"):
        raise Refus("l'arbre a changé pendant la livraison : arrêt (ce qui précède est fait, rien de ce qui suit).")


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


def sonder(cible: str, duree_s: float = 60.0, pause_s: float = 5.0) -> None:
    url = URLS[cible] + "/api/public/health"
    dernier = "rien"
    echeance = time.monotonic() + duree_s
    while True:
        try:
            reste = max(1.0, min(10.0, echeance - time.monotonic()))
            with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "gites-livrer"}), timeout=reste) as r:
                corps = r.read(4096).decode("utf-8", "replace")
                if r.geturl() != url:
                    dernier = f"redirigé vers {r.geturl()}"
                elif 200 <= r.status < 300:
                    donnees = json.loads(corps)
                    if isinstance(donnees, dict) and donnees.get("ok") is True:
                        print(f"Sonde verte : {url} -> {corps}")
                        return
                dernier = f"HTTP {r.status} {corps[:200]}"
        except urllib.error.HTTPError as e:
            dernier = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError, ValueError) as e:
            dernier = f"{type(e).__name__}: {e}"
        if time.monotonic() + pause_s >= echeance:
            break
        time.sleep(pause_s)
    raise Refus(f"sonde ROUGE : {url} ne répond pas ok après une minute (dernier : {dernier}).")


def geste_manager() -> None:
    print(
        "\n── Geste de Julien : redémarrer le site dans le Manager Infomaniak\n"
        f"   {MANAGER} → Hébergement web → site Node.js dev1.mdcdy.be → Redémarrer.\n"
        "   Au démarrage, le serveur reprend main et applique lui-même les migrations en attente.",
        flush=True,
    )
    input("   Entrée quand le site est redémarré (la sonde suit)… ")


def livrer_infomaniak(sans_sauvegarde: bool) -> None:
    # La sonde n'a de sens qu'après le redémarrage, que seul Julien fait : sans
    # terminal pour l'attendre, elle validerait l'ancienne version.
    if not sys.stdin.isatty():
        raise Refus("make livrer se lance dans un terminal : il attend le redémarrage du site dans le Manager avant la sonde.")
    head = gardes("prod")
    verrou = verrou_de("prod")
    try:
        if sans_sauvegarde:
            print("\n── Sauvegarde : SAUTÉE (--sans-sauvegarde) — à ne faire que tant que le compte « sauvegarde » n'existe pas.", flush=True)
        else:
            etape("Sauvegarde", [PYTHON, str(RACINE / "scripts" / "sauvegarde_nuit.py"), "--cible", "infomaniak", "--origine", "livraison"])
        meme_arbre(head)
        if git("rev-parse", "origin/main") == head:
            print(f"\n── Push : origin/main est déjà {head[:8]}, rien à pousser.", flush=True)
        else:
            etape("Push de main", ["git", "push", "origin", f"{head}:refs/heads/main"])
        geste_manager()
        sonder("prod")
        r = subprocess.run([PYTHON, str(RACINE / "scripts" / "gites_sonde.py"), "--url", URLS["prod"], "--sans-telegram"], cwd=RACINE)
        if r.returncode != 0:
            raise Refus(f"{head[:8]} est poussé et le site répond, mais la sonde complète est ROUGE "
                        "(traitement planifié absent ou en retard : Planificateur Infomaniak ?). À régler avant de considérer la livraison faite.")
        print(f"\nLivré : {head[:8]} sur la production ({URLS['prod']}).")
    finally:
        verrou.close()


def livrer(cible: str) -> None:
    head = gardes(cible)
    verrou = verrou_de(cible)
    try:
        if cible == "essai":
            verifier_secrets_essai()
        sauvegarde = [PYTHON, str(RACINE / "scripts" / "sauvegarde_nuit.py"), "--cible", cible, "--origine", "livraison"]
        # cible « cloudflare » : l'ancien Worker de production et sa base D1
        if cible == "essai":
            sauvegarde.append("--base-vide-admise")  # première livraison : la base d'essai n'a encore aucune table
        etape("Sauvegarde", sauvegarde)
        meme_arbre(head)
        if cible == "cloudflare":
            etape("Migrations distantes", ["npm", "run", "-s", "db:migrate:remote"])
        else:
            etape("Migrations distantes", [str(WRANGLER), "d1", "migrations", "apply", "gites-platform-essai", "--remote", "--env", "essai"])
        meme_arbre(head)
        if cible == "cloudflare":
            etape("Déploiement", [str(WRANGLER), "deploy", "--env", "production"])
        else:
            meme_arbre(head)
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
    p.add_argument("--sans-sauvegarde", action="store_true",
                   help="prod seulement : livrer sans sauvegarde préalable (tant que le compte « sauvegarde » n'existe pas)")
    a = p.parse_args()
    if a.sans_sauvegarde and a.cible != "prod":
        p.error("--sans-sauvegarde ne vaut que pour --cible prod")
    try:
        if a.sonde:
            sonder(a.sonde)
        elif a.cible == "prod":
            livrer_infomaniak(a.sans_sauvegarde)
        else:
            livrer(a.cible)
    except Refus as e:
        print(f"Refusé : {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
