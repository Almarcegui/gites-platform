#!/usr/bin/env python3
"""Deploiement de la plateforme vers un hebergement FTP (Infomaniak).

Usage :
    python3 node/deploy-ftp.py            # televerse le code
    python3 node/deploy-ftp.py --dry-run  # liste ce qui serait envoye

Les identifiants sont lus dans .deploy.vars (gitignore, jamais commite,
jamais affiche). Claude ne les manipule pas : c'est Julien qui remplit ce
fichier. Voir .deploy.vars.example.

Choix techniques
----------------
* stdlib uniquement (ftplib) : aucune dependance a installer, coherent avec la
  doctrine outillage souverain du vault.
* FTPS (FTP_TLS) par defaut : en FTP simple, le mot de passe circule en clair.
  Mettre FTP_TLS=false seulement si l'hebergeur ne le supporte pas.
* La plateforme n'a AUCUNE dependance a l'execution : on televerse le code deja
  compile (dist/), donc pas de `npm install` ni de build sur le serveur.
* Le dossier des donnees (data/) n'est jamais touche : il contient la base
  SQLite de production. Ce script ne supprime jamais rien a distance.
"""

from __future__ import annotations

import fnmatch
import os
import sys
from ftplib import FTP, FTP_TLS, error_perm
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Ce qui part sur le serveur. Tout le reste est ignore.
INCLUDE_DIRS = ["dist", "node", "public", "migrations"]
INCLUDE_FILES = ["package.json"]

# Jamais televerse, meme s'il se trouve dans un dossier inclus.
EXCLUDE_PATTERNS = [
    "*.map", "*.log", ".DS_Store", "*.tmp",
    "deploy-ftp.py",        # inutile sur le serveur
    ".env", ".dev.vars", ".deploy.vars",
]


def load_vars() -> dict[str, str]:
    path = ROOT / ".deploy.vars"
    if not path.exists():
        sys.exit(
            "Fichier .deploy.vars absent.\n"
            "  cp .deploy.vars.example .deploy.vars\n"
            "puis renseigne tes identifiants Infomaniak (le fichier est gitignore)."
        )
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    for required in ("FTP_HOST", "FTP_USER", "FTP_PASSWORD"):
        if not out.get(required):
            sys.exit(f"{required} manquant dans .deploy.vars")
    return out


def excluded(name: str) -> bool:
    return any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDE_PATTERNS)


def collect() -> list[Path]:
    files: list[Path] = []
    for directory in INCLUDE_DIRS:
        base = ROOT / directory
        if not base.exists():
            sys.exit(f"Dossier {directory}/ absent — lance d'abord : npm run build")
        for path in sorted(base.rglob("*")):
            if path.is_file() and not excluded(path.name):
                files.append(path)
    for name in INCLUDE_FILES:
        path = ROOT / name
        if path.exists():
            files.append(path)
    return files


def connect(cfg: dict[str, str]) -> FTP:
    host = cfg["FTP_HOST"]
    use_tls = cfg.get("FTP_TLS", "true").lower() != "false"
    if use_tls:
        ftp: FTP = FTP_TLS(host, timeout=30)
        ftp.login(cfg["FTP_USER"], cfg["FTP_PASSWORD"])
        ftp.prot_p()  # chiffre aussi le canal de donnees, pas seulement l'auth
    else:
        print("!! FTP en clair : le mot de passe circule sans chiffrement.")
        ftp = FTP(host, timeout=30)
        ftp.login(cfg["FTP_USER"], cfg["FTP_PASSWORD"])
    remote_root = cfg.get("FTP_REMOTE_DIR", "").strip("/")
    if remote_root:
        ensure_dir(ftp, remote_root)
        ftp.cwd("/" + remote_root)
    return ftp


def ensure_dir(ftp: FTP, remote_dir: str) -> None:
    """Cree l'arborescence distante segment par segment (mkd n'est pas recursif)."""
    current = ftp.pwd()
    for segment in remote_dir.split("/"):
        if not segment:
            continue
        try:
            ftp.cwd(segment)
        except error_perm:
            try:
                ftp.mkd(segment)
            except error_perm as exc:
                if not str(exc).startswith("550"):  # 550 = existe deja
                    raise
            ftp.cwd(segment)
    ftp.cwd(current)


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    cfg = load_vars()
    files = collect()
    total = sum(f.stat().st_size for f in files)
    print(f"{len(files)} fichiers, {total / 1_048_576:.1f} Mo")
    print(f"Cible : {cfg['FTP_HOST']} /{cfg.get('FTP_REMOTE_DIR', '').strip('/')}")

    if dry_run:
        for f in files:
            print(f"  {f.relative_to(ROOT)}")
        print("\n(--dry-run : rien n'a ete envoye)")
        return

    ftp = connect(cfg)
    made: set[str] = set()
    sent = 0
    try:
        for path in files:
            relative = path.relative_to(ROOT).as_posix()
            parent = os.path.dirname(relative)
            if parent and parent not in made:
                ensure_dir(ftp, parent)
                made.add(parent)
            with path.open("rb") as handle:
                ftp.storbinary(f"STOR {relative}", handle)
            sent += 1
            if sent % 20 == 0 or sent == len(files):
                print(f"  {sent}/{len(files)}")
    finally:
        try:
            ftp.quit()
        except Exception:
            ftp.close()

    print(f"\nTermine : {sent} fichiers televerses.")
    print("Etapes suivantes dans le Manager Infomaniak :")
    print("  1. Site Node.js : commande de demarrage = node node/server.mjs")
    print("  2. Variables d'environnement (ou fichier .env a la racine)")
    print("  3. Redemarrer l'application, puis :")
    print("     ADMIN_TOKEN=... node node/verify-deploy.mjs https://dev1.mdcdy.be")


if __name__ == "__main__":
    main()
