#!/opt/homebrew/bin/python3
# Sauvegarde de la base des gîtes (production Infomaniak par HTTPS, base + archive .tar des photos ; ou D1 Cloudflare/essai par wrangler) dans sauvegardes/, rotation à 30 jours, une ligne dans ~/Library/Logs/gites-sauvegarde.log, sortie 1 sur échec.
# Usage : /opt/homebrew/bin/python3 scripts/sauvegarde_nuit.py [--cible infomaniak|cloudflare|essai] [--origine nuit|manuel|livraison] [--garder-jours 30] [--base-vide-admise]
"""Sauvegarde de nuit de la base des gîtes dans sauvegardes/, 30 jours gardés.

Trois cibles :
- `infomaniak` (la production depuis la décision de Julien du 10/10/2026, site
  Node chez Infomaniak, https://dev1.mdcdy.be) : sans SSH, par HTTPS. Le script
  ouvre une session avec le compte réservé `sauvegarde` du back-office (il
  n'ouvre que l'export), tire GET /api/admin/export.sqlite (instantané
  VACUUM INTO, fichier SQLite complet), puis GET /api/admin/export-uploads.tar
  (les photos de UPLOADS_DIR, archive .tar vérifiée nom par nom, même
  rotation que la base), ferme la session. Identifiants dans
  ~/.config/gites/sauvegarde.env (droits 600, jamais dans le dépôt ; modèle :
  scripts/sauvegarde.env.example) ;
- `cloudflare` : l'ancienne base D1 de production, par `wrangler d1 export`,
  tant que le Worker existe (`prod` en est l'ancien nom, gardé pour le
  LaunchAgent chargé avant la bascule) ;
- `essai` : la base D1 d'essai.

Lancée chaque nuit à 3 h 30 par le LaunchAgent com.julien.gites-sauvegarde, par
`make sauvegarde`, et par `scripts/livrer.py` avant chaque livraison.

Ce script ne fait que LIRE la base. Il n'écrit jamais vers elle (la session
ouverte sur le back-office laisse une ligne « export.sqlite » au journal
d'audit, c'est tout).

Garanties :
- l'export passe par un fichier temporaire, vérifié en entier avant d'être mis
  en place (export SQL : rejoué dans une base SQLite en mémoire ; fichier
  SQLite : ouvert en lecture seule) — `integrity_check`, tables attendues ; un
  export coupé ou illisible ne porte jamais un nom de sauvegarde ;
- la mise en place ne remplace jamais un fichier existant (lien exclusif, puis
  fsync du fichier et du dossier) ;
- la rotation ne tourne qu'après une sauvegarde réussie, ne vise que les
  fichiers « AAAA-MM-JJ[-HHMMSS[-n]]-<base>.sql|.sqlite » de plus de 30 jours, et garde
  toujours les 7 plus récents, même plus vieux : un mois de nuits manquées ne
  vide pas le dossier (voulu) ; « pre-deploy-* » et tout autre fichier ne sont
  jamais touchés ;
- une seule sauvegarde à la fois (verrou) ; au délai, tout le groupe de
  processus de l'export (npm, wrangler) est tué avant le nettoyage ;
- seul wrangler du dépôt (node_modules/.bin, version du verrou npm) est admis ;
- le journal reçoit une ligne par passage, sans l'URL de téléchargement signée
  que wrangler affiche (elle donne la base entière pendant une heure), ni le
  mot de passe ou la session du compte `sauvegarde` ;
- infomaniak : HTTPS obligatoire (sauf localhost, pour l'essai local), fichier
  d'identifiants refusé s'il est lisible par d'autres que Julien.

python3 de Homebrew obligatoire sous launchd : /usr/bin/python3 ne lit rien
sous ~/Documents (TCC).
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import signal
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
# GITES_SAUVEGARDE_JOURNAL : pour un essai, ne pas écrire dans le journal de la vraie sauvegarde.
JOURNAL = Path(os.environ.get("GITES_SAUVEGARDE_JOURNAL") or (Path.home() / "Library" / "Logs" / "gites-sauvegarde.log"))
# Nom de la base dans le nom de fichier de la sauvegarde.
BASES = {"infomaniak": "gites-infomaniak", "cloudflare": "gites-platform", "essai": "gites-platform-essai"}
ALIAS = {"prod": "cloudflare"}  # ancien nom, gardé pour le LaunchAgent chargé avant la bascule
IDENTIFIANTS = Path(os.environ.get("GITES_SAUVEGARDE_ENV") or (Path.home() / ".config" / "gites" / "sauvegarde.env"))
TAILLE_MAX_EXPORT = 512 * 1024 * 1024
# Archive des photos (lot 3) : nom de base distinct, même rotation que la base.
BASE_PHOTOS = "gites-infomaniak-photos"
TAILLE_MAX_PHOTOS = 4 * 1024 * 1024 * 1024
NOM_PHOTO = re.compile(r"^[0-9a-f]{32}\.(?:jpg|png|webp)$")
DELAI_HTTP_S = 120
# Le plancher de toute sauvegarde ; le reste se déduit des migrations appliquées
# (tables_attendues) : chaque table créée par une migration que la base dit avoir
# jouée doit être dans l'export.
TABLES_TOUJOURS = ("d1_migrations", "properties", "units", "bookings")
# Un export d'une base sans aucune table tient en quelques octets (PRAGMA).
TAILLE_MAX_BASE_VIDE = 4096
GARDER_TOUJOURS = 7
DELAI_EXPORT_S = 600
# launchd ne lit ni .zshrc ni .bash_profile : npm et node sont chez Homebrew.
CHEMIN = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


class Echec(Exception):
    """Une sauvegarde manquée, avec sa raison (une ligne)."""


def dossier_des_sauvegardes() -> Path:
    """`sauvegardes/` du clone principal, même lancé depuis un worktree (.worktrees/…) :
    une sauvegarde faite dans un worktree disparaîtrait avec lui."""
    try:
        commun = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=RACINE, capture_output=True, text=True, timeout=30, check=True,
        ).stdout.strip()
        principal = Path(commun).parent
        if (principal / "wrangler.jsonc").is_file():
            return principal / "sauvegardes"
    except (OSError, subprocess.SubprocessError):
        pass
    return RACINE / "sauvegardes"


DOSSIER = Path(os.environ["GITES_SAUVEGARDES"]) if os.environ.get("GITES_SAUVEGARDES") else dossier_des_sauvegardes()


def commande_export(cible: str, fichier: Path) -> list[str]:
    if cible == "cloudflare":
        # Le script npm existant. Sans --env : le bloc racine de wrangler.jsonc
        # vise déjà la base de production, et `--env production` a valu une
        # erreur d'autorisation 7403 à l'export sur ce compte (août 2026).
        return ["npm", "run", "-s", "db:export:remote", "--", str(fichier)]
    wrangler = str(RACINE / "node_modules" / ".bin" / "wrangler")
    return [wrangler, "d1", "export", BASES["essai"], "--remote", "--env", "essai", "--output", str(fichier)]


def journaliser(ligne: str) -> None:
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    horodatage = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    with JOURNAL.open("a", encoding="utf-8") as f:
        f.write(f"{horodatage} {ligne}\n")


def nettoyer_sortie(texte: str) -> str:
    """Retire les codes de couleur et les URL (wrangler affiche une URL signée qui
    donne la base entière pendant une heure)."""
    texte = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", texte)
    return re.sub(r"https?://\S+", "<url retirée>", texte)


def exporter(cible: str, fichier: Path) -> None:
    env = dict(os.environ, PATH=os.environ.get("PATH", "") + ":" + CHEMIN, NO_COLOR="1", FORCE_COLOR="0")
    env.setdefault("HOME", str(Path.home()))
    try:
        p = subprocess.Popen(
            commande_export(cible, fichier), cwd=RACINE, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True,
        )
    except OSError as e:
        raise Echec(f"export impossible à lancer ({e})") from e
    try:
        sortie, _ = p.communicate(timeout=DELAI_EXPORT_S)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)  # npm ET le wrangler qu'il a lancé
        p.communicate()
        raise Echec(f"export interrompu après {DELAI_EXPORT_S} s")
    if p.returncode != 0:
        sortie = nettoyer_sortie(sortie or "")
        erreurs = [l.strip() for l in sortie.splitlines() if "ERROR" in l or "✘" in l]
        motif = (erreurs[-1] if erreurs else (sortie.strip().splitlines() or ["sans message"])[-1])[:300]
        raise Echec(f"wrangler d1 export, code {p.returncode} : {motif}")


def lire_identifiants(chemin: Path = IDENTIFIANTS) -> dict[str, str]:
    """GITES_URL, GITES_USER, GITES_PASSWORD depuis ~/.config/gites/sauvegarde.env."""
    if not chemin.is_file():
        raise Echec(f"identifiants absents : {chemin} (modèle : scripts/sauvegarde.env.example ; compte « sauvegarde » à créer dans Utilisateurs)")
    if stat.S_IMODE(chemin.stat().st_mode) & 0o077:
        raise Echec(f"{chemin} est lisible par d'autres comptes : chmod 600 \"{chemin}\"")
    valeurs: dict[str, str] = {}
    for ligne in chemin.read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if not ligne or ligne.startswith("#") or "=" not in ligne:
            continue
        cle, valeur = ligne.split("=", 1)
        valeur = valeur.strip()
        if len(valeur) >= 2 and valeur[0] == valeur[-1] and valeur[0] in "\"'":
            valeur = valeur[1:-1]
        valeurs[cle.strip()] = valeur
    manquantes = [c for c in ("GITES_URL", "GITES_USER", "GITES_PASSWORD") if not valeurs.get(c)]
    if manquantes:
        raise Echec(f"{chemin} : {', '.join(manquantes)} manquant(s)")
    url = urllib.parse.urlsplit(valeurs["GITES_URL"])
    local = url.hostname in ("localhost", "127.0.0.1", "::1")
    if url.scheme != "https" and not (url.scheme == "http" and local):
        raise Echec(f"GITES_URL doit être en https (reçu : {url.scheme}://{url.hostname})")
    valeurs["GITES_URL"] = valeurs["GITES_URL"].rstrip("/")
    return valeurs


class _SansRedirection(urllib.request.HTTPRedirectHandler):
    """Aucune redirection suivie : urllib recopierait l'en-tête Authorization (la
    session donne la base entière) vers l'adresse de destination, quelle qu'elle soit."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirection refusée vers {newurl}", headers, fp)


_OUVREUR = urllib.request.build_opener(_SansRedirection)


def _ouvrir(req: urllib.request.Request, timeout: float):
    return _OUVREUR.open(req, timeout=timeout)


def _requete(url: str, methode: str = "GET", corps: dict | None = None, jeton: str | None = None) -> urllib.request.Request:
    entetes = {"user-agent": "gites-sauvegarde-nuit", "accept": "*/*"}
    if corps is not None:
        entetes["content-type"] = "application/json"
    if jeton:
        entetes["authorization"] = f"Bearer {jeton}"
    donnees = json.dumps(corps).encode("utf-8") if corps is not None else None
    return urllib.request.Request(url, data=donnees, method=methode, headers=entetes)


def _motif_http(e: urllib.error.HTTPError) -> str:
    try:
        texte = json.loads(e.read(2048).decode("utf-8", "replace")).get("error", "")
    except (ValueError, AttributeError, OSError):
        texte = ""
    if 300 <= e.code < 400:
        return f"HTTP {e.code} : redirection refusée (GITES_URL doit être l'adresse exacte, en https)"
    return f"HTTP {e.code}{' : ' + str(texte)[:200] if texte else ''}"


class _RouteAbsente(Exception):
    """404 ou 501 sur l'export des photos : serveur sans la route ou sans photos."""


def _telecharger(url: str, jeton: str, fichier: Path, plafond: int, quoi: str) -> int:
    try:
        with _ouvrir(_requete(url, jeton=jeton), timeout=DELAI_HTTP_S) as r, fichier.open("wb") as sortie:
            total = 0
            while True:
                bloc = r.read(1 << 20)
                if not bloc:
                    break
                total += len(bloc)
                if total > plafond:
                    raise Echec(f"{quoi} de plus de {plafond >> 20} Mo : arrêté")
                sortie.write(bloc)
            return total
    except urllib.error.HTTPError as e:
        if quoi == "photos" and e.code in (404, 501):
            raise _RouteAbsente() from e
        raise Echec(f"{quoi} refusé ({_motif_http(e)})") from e
    except (urllib.error.URLError, OSError) as e:
        raise Echec(f"{quoi} interrompu ({type(e).__name__}: {str(e)[:150]})") from e


def verifier_photos(fichier: Path) -> str:
    """L'archive se lit en entier ; chaque membre est un fichier plat au nom attendu."""
    taille = fichier.stat().st_size
    try:
        with tarfile.open(fichier, "r:") as t:
            membres = t.getmembers()
            for m in membres:
                if not m.isfile() or not NOM_PHOTO.match(m.name):
                    raise Echec(f"archive des photos refusée : membre inattendu ({m.name[:60]!r})")
                f = t.extractfile(m)
                if f is None or len(f.read()) != m.size:
                    raise Echec(f"archive des photos coupée ({m.name})")
    except tarfile.TarError as e:
        raise Echec(f"archive des photos illisible ({taille} octets) : {type(e).__name__}") from e
    return f"{len(membres)} photo(s), {taille} octets"


def exporter_infomaniak(fichier: Path, photos: Path | None = None) -> None:
    """Session du compte « sauvegarde », GET /api/admin/export.sqlite, puis
    GET /api/admin/export-uploads.tar si `photos` est donné, fin de session."""
    ids = lire_identifiants()
    base = ids["GITES_URL"]
    try:
        with _ouvrir(_requete(f"{base}/api/admin/login", "POST",
                                             {"user": ids["GITES_USER"], "password": ids["GITES_PASSWORD"]}),
                                    timeout=DELAI_HTTP_S) as r:
            session = json.loads(r.read(65536).decode("utf-8")).get("session")
    except urllib.error.HTTPError as e:
        raise Echec(f"connexion du compte {ids['GITES_USER']} refusée ({_motif_http(e)})") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise Echec(f"{base} injoignable ({type(e).__name__}: {str(e)[:150]})") from e
    if not session:
        # Un couple du secret ADMIN_TOKEN n'ouvre pas de session : le compte doit vivre en base.
        raise Echec(f"pas de session pour {ids['GITES_USER']} : créer le compte dans la page Utilisateurs du back-office")
    jeton = f"session:{session}"
    try:
        _telecharger(f"{base}/api/admin/export.sqlite", jeton, fichier, TAILLE_MAX_EXPORT, "export")
        if photos is not None:
            try:
                _telecharger(f"{base}/api/admin/export-uploads.tar", jeton, photos, TAILLE_MAX_PHOTOS, "photos")
            except _RouteAbsente:
                # Serveur antérieur au lot 3 (ou cible sans photos) : la base
                # reste sauvegardée, l'absence est dite au journal.
                photos.unlink(missing_ok=True)
    finally:
        try:
            _ouvrir(_requete(f"{base}/api/admin/logout", "POST", {}, jeton=jeton), timeout=30).close()
        except (urllib.error.URLError, OSError):
            pass  # la session expire seule (30 jours) ; l'échec du logout n'invalide pas la sauvegarde


def verifier_sqlite(fichier: Path) -> str:
    """Ouvre le fichier SQLite rapatrié en lecture seule ; rend un résumé ou lève Echec."""
    taille = fichier.stat().st_size
    with fichier.open("rb") as f:
        if f.read(16) != b"SQLite format 3\x00":
            raise Echec(f"export illisible ({taille} octets) : ce n'est pas un fichier SQLite")
    try:
        c = sqlite3.connect(f"{fichier.as_uri()}?mode=ro", uri=True)
        try:
            integrite = c.execute("PRAGMA integrity_check").fetchone()[0]
            tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            appliquees = {r[0] for r in c.execute("SELECT name FROM _migrations")} if "_migrations" in tables else set()
            resas = c.execute("SELECT COUNT(*) FROM bookings").fetchone()[0] if "bookings" in tables else None
        finally:
            c.close()
    except sqlite3.Error as e:
        raise Echec(f"export illisible ({taille} octets) : {type(e).__name__}") from e
    if integrite != "ok":
        raise Echec(f"export incohérent ({taille} octets) : integrity_check = {integrite[:200]}")
    tables.discard("sqlite_sequence")
    manquantes = sorted({"_migrations", "properties", "units", "bookings"} - tables)
    if manquantes:
        raise Echec(f"export incomplet ({taille} octets) : tables absentes {', '.join(manquantes)}")
    if not appliquees:
        raise Echec(f"export incomplet ({taille} octets) : aucune migration dans _migrations")
    manquantes = sorted(tables_attendues(appliquees) - tables)
    if manquantes:
        raise Echec(f"export incomplet ({taille} octets) : tables des migrations absentes {', '.join(manquantes)}")
    return f"{taille} octets, {len(tables)} tables, {len(appliquees)} migrations, {resas} réservation(s)"


def tables_attendues(migrations_appliquees: set[str]) -> set[str]:
    """Les tables qu'ont laissées les migrations appliquées, lues dans migrations/
    (CREATE TABLE, DROP TABLE, ALTER TABLE … RENAME TO, dans l'ordre des fichiers)."""
    tables: set[str] = set()
    nom = r'"?([A-Za-z_][A-Za-z0-9_]*)"?'
    motif = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?" + nom
        + r"|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?" + nom
        + r"|ALTER\s+TABLE\s+" + nom + r"\s+RENAME\s+TO\s+" + nom,
        re.IGNORECASE,
    )
    for f in sorted((RACINE / "migrations").glob("*.sql")):
        if f.name not in migrations_appliquees:
            continue
        sql = re.sub(r"--[^\n]*", "", f.read_text(encoding="utf-8"))
        for m in motif.finditer(sql):
            cree, supprimee, avant, apres = m.groups()
            if cree:
                tables.add(cree)
            elif supprimee:
                tables.discard(supprimee)
            else:
                tables.discard(avant)
                tables.add(apres)
    return tables


def verifier(fichier: Path, base_vide_admise: bool) -> str:
    """Rejoue l'export dans une base en mémoire. Rend un résumé ; lève Echec sinon."""
    taille = fichier.stat().st_size
    if taille == 0:
        raise Echec("export vide")
    try:
        texte = fichier.read_text(encoding="utf-8")  # la base fait moins d'un Mo : la rejouer exige le texte entier
        c = sqlite3.connect(":memory:")
        c.executescript(texte)
        integrite = c.execute("PRAGMA integrity_check").fetchone()[0]
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    except (UnicodeDecodeError, sqlite3.Error) as e:
        # Le type seulement : le message de SQLite cite le texte fautif, donc des données de la base.
        raise Echec(f"export illisible ({taille} octets) : {type(e).__name__}") from e
    if integrite != "ok":
        raise Echec(f"export incohérent ({taille} octets) : integrity_check = {integrite[:200]}")
    tables.discard("sqlite_sequence")
    if not tables and base_vide_admise and taille <= TAILLE_MAX_BASE_VIDE and "CREATE" not in texte.upper():
        return f"{taille} octets, base vide (aucune table)"
    if not texte.rstrip().endswith(";"):
        raise Echec(f"export incomplet ({taille} octets) : la dernière instruction n'est pas terminée")
    manquantes = sorted(set(TABLES_TOUJOURS) - tables)
    if manquantes:
        raise Echec(f"export incomplet ({taille} octets) : tables absentes {', '.join(manquantes)}")
    appliquees = {r[0] for r in c.execute("SELECT name FROM d1_migrations")}
    if not appliquees:
        raise Echec(f"export incomplet ({taille} octets) : aucune migration dans d1_migrations")
    manquantes = sorted(tables_attendues(appliquees) - tables)
    if manquantes:
        raise Echec(f"export incomplet ({taille} octets) : tables des migrations absentes {', '.join(manquantes)}")
    resas = c.execute("SELECT COUNT(*) FROM bookings").fetchone()[0]
    return f"{taille} octets, {len(tables)} tables, {len(appliquees)} migrations, {resas} réservation(s)"


def mettre_en_place(temporaire: Path, base: str, ext: str = ".sql") -> Path:
    """Lien exclusif : jamais un fichier existant remplacé ; fsync du fichier et du dossier."""
    with temporaire.open("rb") as f:
        os.fsync(f.fileno())
    os.chmod(temporaire, 0o600)
    racine_nom = f"{dt.datetime.now():%Y-%m-%d-%H%M%S}"
    for n in range(0, 100):
        final = DOSSIER / (f"{racine_nom}-{base}{ext}" if n == 0 else f"{racine_nom}-{n}-{base}{ext}")
        try:
            os.link(temporaire, final)
            break
        except FileExistsError:
            continue
    else:
        raise Echec("aucun nom libre pour la sauvegarde")
    descripteur = os.open(DOSSIER, os.O_RDONLY)
    try:
        os.fsync(descripteur)
    finally:
        os.close(descripteur)
    return final


def proteger_le_dossier() -> None:
    """Sous le verrou : les temporaires d'un passage tué (données de production,
    que la rotation ne voit pas) sont effacés ; chaque dump n'est lisible que du
    propriétaire. Les liens symboliques ne sont jamais suivis."""
    for chemin in DOSSIER.iterdir():
        if chemin.is_symlink() or not chemin.is_file():
            continue
        if chemin.name.startswith(".export-") and chemin.suffix in (".sql", ".sqlite", ".tar"):
            chemin.unlink()
        elif chemin.suffix in (".sql", ".sqlite", ".tar"):
            os.chmod(chemin, 0o600)


def rotation(base: str, garder_jours: int, aujourd_hui: dt.date, ext: str = ".sql") -> list[str]:
    motif = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-\d{6}(?:-\d+)?)?-" + re.escape(base) + re.escape(ext) + r"$")
    trouvees: list[tuple[str, dt.date, Path]] = []
    for chemin in DOSSIER.iterdir():
        m = motif.match(chemin.name)
        if not m or chemin.is_symlink() or not chemin.is_file():
            continue
        try:
            jour = dt.date.fromisoformat(m.group(1))
        except ValueError:
            continue
        trouvees.append((chemin.name, jour, chemin))
    trouvees.sort(key=lambda t: t[0], reverse=True)  # préfixe ISO : ordre alphabétique = ordre chronologique
    limite = aujourd_hui - dt.timedelta(days=garder_jours)
    supprimees: list[str] = []
    for nom, jour, chemin in trouvees[GARDER_TOUJOURS:]:
        if jour < limite:
            chemin.unlink()
            supprimees.append(nom)
    return supprimees


def sauvegarder(cible: str, garder_jours: int, base_vide_admise: bool) -> tuple[Path, str]:
    base = BASES[cible]
    ext = ".sqlite" if cible == "infomaniak" else ".sql"
    if cible != "infomaniak" and not (RACINE / "node_modules" / ".bin" / "wrangler").exists():
        raise Echec("node_modules/.bin/wrangler absent : make installer d'abord (aucun wrangler global n'est admis)")
    DOSSIER.mkdir(mode=0o700, exist_ok=True)
    os.chmod(DOSSIER, 0o700)  # mkdir ne corrige pas un dossier existant
    with (DOSSIER / ".verrou").open("w") as verrou:
        try:
            fcntl.flock(verrou, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise Echec("une autre sauvegarde tourne déjà") from e
        proteger_le_dossier()
        descripteur, nom = tempfile.mkstemp(prefix=".export-", suffix=ext, dir=DOSSIER)
        os.close(descripteur)
        temporaire = Path(nom)
        photos_tmp: Path | None = None
        if cible == "infomaniak":
            descripteur, nom = tempfile.mkstemp(prefix=".export-", suffix=".tar", dir=DOSSIER)
            os.close(descripteur)
            photos_tmp = Path(nom)
        resume_photos = ""
        try:
            if cible == "infomaniak":
                exporter_infomaniak(temporaire, photos_tmp)
                resume = verifier_sqlite(temporaire)
            else:
                exporter(cible, temporaire)
                resume = verifier(temporaire, base_vide_admise)
            final = mettre_en_place(temporaire, base, ext)
            if photos_tmp is not None:
                if photos_tmp.exists():
                    resume_photos = f" ; photos : {verifier_photos(photos_tmp)}"
                    mettre_en_place(photos_tmp, BASE_PHOTOS, ".tar")
                    rotation(BASE_PHOTOS, garder_jours, dt.date.today(), ".tar")
                else:
                    resume_photos = " ; photos : route absente sur le serveur (antérieur au lot 3), non sauvegardées"
        finally:
            temporaire.unlink(missing_ok=True)
            if photos_tmp is not None:
                photos_tmp.unlink(missing_ok=True)
        supprimees = rotation(base, garder_jours, dt.date.today(), ext)
    return final, (f"{resume}{resume_photos} ; rotation : {len(supprimees)} supprimée(s) "
                   f"({garder_jours} jours, {GARDER_TOUJOURS} gardées au moins)")


def main() -> int:
    p = argparse.ArgumentParser(description="Sauvegarde de la base des gîtes (Infomaniak par HTTPS, D1 par wrangler).")
    p.add_argument("--cible", choices=sorted(BASES) + sorted(ALIAS), default="infomaniak",
                   help="infomaniak (production, défaut) · cloudflare (ancienne D1) · essai · prod = ancien nom de cloudflare")
    p.add_argument("--origine", choices=["nuit", "manuel", "livraison"], default="nuit")
    p.add_argument("--garder-jours", type=int, default=30)
    p.add_argument("--base-vide-admise", action="store_true",
                   help="essai seulement : une base sans aucune table (pas encore migrée) passe pour sauvegardée")
    a = p.parse_args()
    if a.garder_jours < 1:
        p.error("--garder-jours doit valoir au moins 1")
    a.cible = ALIAS.get(a.cible) or a.cible
    if a.base_vide_admise and a.cible != "essai":
        p.error("--base-vide-admise ne vaut que pour --cible essai")
    # Une seule ligne de journal par passage, écrite ici et nulle part ailleurs.
    try:
        final, resume = sauvegarder(a.cible, a.garder_jours, a.base_vide_admise)
        ligne, code = f"OK {a.cible} {a.origine} {final} {resume}", 0
    except Echec as e:
        ligne, code = f"ÉCHEC {a.cible} {a.origine} : {e}", 1
    except Exception as e:  # imprévue : elle doit laisser sa ligne au journal
        ligne, code = f"ÉCHEC {a.cible} {a.origine} : erreur imprévue {type(e).__name__}: {str(e)[:200]}", 1
    try:
        journaliser(ligne)
    except OSError as e:
        print(f"Journal impossible à écrire ({e}) : {ligne}", file=sys.stderr)
        code = 1
    print(ligne, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
