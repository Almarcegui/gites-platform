#!/opt/homebrew/bin/python3
# Client en ligne de commande de l'API admin des gîtes, par une clé d'accès de service (Bearer svc:<clé>, ~/.config/gites/service.env) : santé, statut et liaison Beds24, annulation d'une réservation, export de la base. Sortie JSON, jamais la clé.
# Usage : /opt/homebrew/bin/python3 scripts/gites_admin.py sante | beds24-statut | beds24-lier <code> | resa-annuler <référence> --motif "…" [--oui] | export-sauvegarde [--sortie fichier.sqlite]
"""Client de l'API admin de la plateforme des gîtes, pour Claude et les scripts du Mac.

Authentification : une clé d'accès de service (pas un compte humain), créée par
Julien dans le back-office (page Utilisateurs › Accès de service) et rangée dans
~/.config/gites/service.env (droits 600, modèle scripts/service.env.example) :

    GITES_URL=https://dev1.mdcdy.be
    GITES_SERVICE_KEY=gsk_…

Sous-commandes :
  sante                         site, base, traitement planifié, accès à l'API admin
  beds24-statut                 liaison Beds24 (compte, propriétés)
  beds24-lier <code>            échange un code d'invitation Beds24 (valable 24 h)
                                et enregistre le jeton de liaison sur le serveur
  resa-annuler <réf> --motif M  montre la réservation ; l'annule seulement avec --oui
  export-sauvegarde             copie complète de la base (fichier SQLite, 600)

Sortie : du JSON indenté sur stdout ; erreurs en JSON sur stderr, code 1.
La clé n'apparaît jamais dans une sortie ni dans un message d'erreur. HTTPS
obligatoire (http seulement pour localhost) ; aucune redirection suivie (urllib
y recopierait l'en-tête Authorization).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get("GITES_SERVICE_ENV") or (Path.home() / ".config" / "gites" / "service.env"))
DELAI_S = 60


class Erreur(Exception):
    pass


def lire_config(chemin: Path = CONFIG) -> tuple[str, str]:
    if not chemin.is_file():
        raise Erreur(f"configuration absente : {chemin} (modèle : scripts/service.env.example)")
    if stat.S_IMODE(chemin.stat().st_mode) & 0o077:
        raise Erreur(f"{chemin} est lisible par d'autres comptes : chmod 600")
    valeurs: dict[str, str] = {}
    for ligne in chemin.read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if ligne and not ligne.startswith("#") and "=" in ligne:
            cle, val = ligne.split("=", 1)
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            valeurs[cle.strip()] = val
    url, cle = valeurs.get("GITES_URL", "").rstrip("/"), valeurs.get("GITES_SERVICE_KEY", "")
    if not url or not cle:
        raise Erreur(f"{chemin} : GITES_URL et GITES_SERVICE_KEY sont requis")
    p = urllib.parse.urlsplit(url)
    local = p.hostname in ("localhost", "127.0.0.1", "::1")
    if p.scheme != "https" and not (p.scheme == "http" and local):
        raise Erreur("GITES_URL doit être en https")
    return url, cle


class _SansRedirection(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirection refusée ({msg}) vers {newurl}", headers, fp)


_OUVREUR = urllib.request.build_opener(_SansRedirection)


class Api:
    def __init__(self, url: str, cle: str):
        self.url = url
        self.__cle = cle

    def ouvrir(self, methode: str, chemin: str, corps: dict | None = None, auth: bool = True):
        entetes = {"user-agent": "gites-admin", "accept": "application/json"}
        if auth:
            entetes["authorization"] = f"Bearer svc:{self.__cle}"
        donnees = None
        if corps is not None:
            entetes["content-type"] = "application/json"
            donnees = json.dumps(corps).encode("utf-8")
        req = urllib.request.Request(self.url + chemin, data=donnees, method=methode, headers=entetes)
        try:
            return _OUVREUR.open(req, timeout=DELAI_S)
        except urllib.error.HTTPError as e:
            try:
                motif = json.loads(e.read(4096).decode("utf-8", "replace")).get("error", "")
            except (ValueError, AttributeError, OSError):
                motif = ""
            raise Erreur(f"{methode} {chemin.split('?')[0]} : HTTP {e.code}{' — ' + str(motif)[:300] if motif else ''}") from None
        except (urllib.error.URLError, OSError) as e:
            raise Erreur(f"{self.url} injoignable ({type(e).__name__})") from None

    def json(self, methode: str, chemin: str, corps: dict | None = None, auth: bool = True):
        with self.ouvrir(methode, chemin, corps, auth) as r:
            texte = r.read(5 * 1024 * 1024).decode("utf-8", "replace")
        try:
            return json.loads(texte) if texte else None
        except ValueError:
            raise Erreur(f"{chemin.split('?')[0]} : réponse qui n'est pas du JSON") from None

    def objet(self, methode: str, chemin: str, corps: dict | None = None, auth: bool = True) -> dict:
        """Comme json(), mais la réponse doit être un objet JSON (sinon : Erreur)."""
        r = self.json(methode, chemin, corps, auth)
        if not isinstance(r, dict):
            raise Erreur(f"{chemin.split('?')[0]} : réponse vide ou qui n'est pas un objet JSON")
        return r


def sante(api: Api, _a) -> dict:
    public = api.json("GET", "/api/public/health", auth=False)
    vue = api.json("GET", "/api/admin/overview?property=1")
    h = (vue or {}).get("health", {}) if isinstance(vue, dict) else {}
    return {
        "site": api.url,
        "public": public,
        "acces_admin": "ok",
        "sante_back_office": {k: h[k] for k in ("ok", "lastCronAt", "beds24StaleHours", "beds24Stale") if k in h},
    }


def beds24_statut(api: Api, _a) -> dict:
    return api.objet("GET", "/api/admin/beds24/status")


def beds24_lier(api: Api, a) -> dict:
    return api.objet("POST", "/api/admin/beds24/invite-code", {"code": a.code})


def resa_annuler(api: Api, a) -> dict:
    ref = a.reference.strip()
    liste = api.json("GET", "/api/admin/bookings?" + urllib.parse.urlencode({"search": ref, "limit": "50"}))
    resas = [b for b in (liste or {}).get("bookings", []) if str(b.get("reference", "")).upper() == ref.upper()]
    if not resas:
        raise Erreur(f"aucune réservation de référence {ref}")
    b = resas[0]
    resume = {k: b.get(k) for k in ("id", "reference", "unitName", "checkin", "checkout", "status", "guestName", "channelLabel")}
    if not a.oui:
        return {"a_annuler": resume, "motif": a.motif, "fait": False, "note": "relancer avec --oui pour annuler"}
    r = api.json("POST", f"/api/admin/bookings/{int(b['id'])}/cancel", {"reason": a.motif})
    return {"annulee": resume, "motif": a.motif, "fait": True, "reponse": r}


def export_sauvegarde(api: Api, a) -> dict:
    sortie = Path(a.sortie) if a.sortie else Path.cwd() / f"gites-{dt.datetime.now():%Y-%m-%d-%H%M%S}.sqlite"
    if sortie.exists():
        raise Erreur(f"{sortie} existe déjà : rien n'est écrasé")
    tmp = sortie.with_name(sortie.name + ".partiel")
    total = 0
    try:
        with api.ouvrir("GET", "/api/admin/export.sqlite") as r, open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as f:
            while bloc := r.read(1 << 20):
                total += len(bloc)
                f.write(bloc)
        with tmp.open("rb") as f:
            if f.read(16) != b"SQLite format 3\x00":
                raise Erreur("l'export reçu n'est pas un fichier SQLite")
        os.link(tmp, sortie)
    finally:
        tmp.unlink(missing_ok=True)
    return {"fichier": str(sortie), "octets": total}


def main() -> int:
    p = argparse.ArgumentParser(description="API admin des gîtes par clé de service.")
    sp = p.add_subparsers(dest="commande", required=True)
    sp.add_parser("sante").set_defaults(f=sante)
    sp.add_parser("beds24-statut").set_defaults(f=beds24_statut)
    x = sp.add_parser("beds24-lier")
    x.add_argument("code")
    x.set_defaults(f=beds24_lier)
    x = sp.add_parser("resa-annuler")
    x.add_argument("reference")
    x.add_argument("--motif", required=True)
    x.add_argument("--oui", action="store_true", help="annuler pour de bon (sans : montre seulement)")
    x.set_defaults(f=resa_annuler)
    x = sp.add_parser("export-sauvegarde")
    x.add_argument("--sortie")
    x.set_defaults(f=export_sauvegarde)
    a = p.parse_args()
    try:
        url, cle = lire_config()
        resultat = a.f(Api(url, cle), a)
    except Erreur as e:
        print(json.dumps({"erreur": str(e)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(resultat, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
