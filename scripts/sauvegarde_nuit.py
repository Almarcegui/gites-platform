#!/opt/homebrew/bin/python3
# Sauvegarde de la base D1 de production (ou d'essai) dans sauvegardes/, rotation à 30 jours, une ligne dans ~/Library/Logs/gites-sauvegarde.log, sortie 1 sur échec.
# Usage : /opt/homebrew/bin/python3 scripts/sauvegarde_nuit.py [--cible prod|essai] [--origine nuit|manuel|livraison] [--garder-jours 30] [--base-vide-admise]
"""Sauvegarde de nuit de la base D1 des gîtes (production, ou essai) dans sauvegardes/, 30 jours gardés.

Lancée chaque nuit à 3 h 30 par le LaunchAgent com.julien.gites-sauvegarde, par
`make sauvegarde`, et par `scripts/livrer.py` avant toute migration distante.

Ce script ne fait que LIRE Cloudflare (`wrangler d1 export`). Il n'écrit jamais
vers la base.

Garanties :
- l'export passe par un fichier temporaire, rejoué en entier dans une base
  SQLite en mémoire (`integrity_check`, tables attendues) avant d'être mis en
  place ; un export coupé ou illisible ne porte jamais un nom de sauvegarde ;
- la mise en place ne remplace jamais un fichier existant (lien exclusif, puis
  fsync du fichier et du dossier) ;
- la rotation ne tourne qu'après une sauvegarde réussie, ne vise que les
  fichiers « AAAA-MM-JJ[-HHMMSS[-n]]-<base>.sql » de plus de 30 jours, et garde
  toujours les 7 plus récents, même plus vieux : un mois de nuits manquées ne
  vide pas le dossier (voulu) ; « pre-deploy-* » et tout autre fichier ne sont
  jamais touchés ;
- une seule sauvegarde à la fois (verrou) ; au délai, tout le groupe de
  processus de l'export (npm, wrangler) est tué avant le nettoyage ;
- seul wrangler du dépôt (node_modules/.bin, version du verrou npm) est admis ;
- le journal reçoit une ligne par passage, sans l'URL de téléchargement signée
  que wrangler affiche (elle donne la base entière pendant une heure).

python3 de Homebrew obligatoire sous launchd : /usr/bin/python3 ne lit rien
sous ~/Documents (TCC).
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
JOURNAL = Path.home() / "Library" / "Logs" / "gites-sauvegarde.log"
BASES = {"prod": "gites-platform", "essai": "gites-platform-essai"}
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
    if cible == "prod":
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


def mettre_en_place(temporaire: Path, base: str) -> Path:
    """Lien exclusif : jamais un fichier existant remplacé ; fsync du fichier et du dossier."""
    with temporaire.open("rb") as f:
        os.fsync(f.fileno())
    os.chmod(temporaire, 0o600)
    racine_nom = f"{dt.datetime.now():%Y-%m-%d-%H%M%S}"
    for n in range(0, 100):
        final = DOSSIER / (f"{racine_nom}-{base}.sql" if n == 0 else f"{racine_nom}-{n}-{base}.sql")
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
        if chemin.name.startswith(".export-") and chemin.suffix == ".sql":
            chemin.unlink()
        elif chemin.suffix == ".sql":
            os.chmod(chemin, 0o600)


def rotation(base: str, garder_jours: int, aujourd_hui: dt.date) -> list[str]:
    motif = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-\d{6}(?:-\d+)?)?-" + re.escape(base) + r"\.sql$")
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
    if not (RACINE / "node_modules" / ".bin" / "wrangler").exists():
        raise Echec("node_modules/.bin/wrangler absent : make installer d'abord (aucun wrangler global n'est admis)")
    DOSSIER.mkdir(mode=0o700, exist_ok=True)
    os.chmod(DOSSIER, 0o700)  # mkdir ne corrige pas un dossier existant
    with (DOSSIER / ".verrou").open("w") as verrou:
        try:
            fcntl.flock(verrou, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise Echec("une autre sauvegarde tourne déjà") from e
        proteger_le_dossier()
        descripteur, nom = tempfile.mkstemp(prefix=".export-", suffix=".sql", dir=DOSSIER)
        os.close(descripteur)
        temporaire = Path(nom)
        try:
            exporter(cible, temporaire)
            resume = verifier(temporaire, base_vide_admise)
            final = mettre_en_place(temporaire, base)
        finally:
            temporaire.unlink(missing_ok=True)
        supprimees = rotation(base, garder_jours, dt.date.today())
    return final, (f"{resume} ; rotation : {len(supprimees)} supprimée(s) "
                   f"({garder_jours} jours, {GARDER_TOUJOURS} gardées au moins)")


def main() -> int:
    p = argparse.ArgumentParser(description="Sauvegarde de la base D1 des gîtes.")
    p.add_argument("--cible", choices=sorted(BASES), default="prod")
    p.add_argument("--origine", choices=["nuit", "manuel", "livraison"], default="nuit")
    p.add_argument("--garder-jours", type=int, default=30)
    p.add_argument("--base-vide-admise", action="store_true",
                   help="essai seulement : une base sans aucune table (pas encore migrée) passe pour sauvegardée")
    a = p.parse_args()
    if a.garder_jours < 1:
        p.error("--garder-jours doit valoir au moins 1")
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
