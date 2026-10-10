# Gites Platform : les commandes du dépôt (méthode reprise de Greffe, 09/10/2026).
#
# `make check` : tout ce qui doit passer avant de dire « fini ».
# `make livrer` : la production, et seulement par là ; `make livrer-essai` : l'essai.
#
# ⚠️ Jamais `make check | tail … && git commit` : un tube rend le code de sortie de
# sa DERNIÈRE commande, et l'échec de `make check` passe inaperçu (arrivé sur
# Greffe le 02/10/2026). Lancer `make check` seul, ou sous `set -o pipefail`.
# Une suite de commandes dont une étape prépare la suivante s'enchaîne par `&&`.
#
# Le make d'Apple est GNU Make 3.81 : il ignore .SHELLFLAGS. Chaque ligne de
# recette est donc une commande simple (make s'arrête si elle échoue), et la
# logique à plusieurs étapes vit dans des scripts Python (scripts/livrer.py,
# scripts/sauvegarde_nuit.py), pas dans des tubes ni des `if` de shell.
#
# Le dossier du dépôt contient un émoji et des espaces (« 🔧 Dev/Gites Platform ») :
# les recettes travaillent en chemins relatifs.

SHELL := /bin/bash
# node et npm viennent de Homebrew ; le python de Homebrew est le seul qui lise
# ~/Documents sous launchd (TCC). wrangler : celui du dépôt (npm ci), jamais un
# wrangler global ni un `npx` qui télécharge.
export PATH := /opt/homebrew/bin:$(PATH)
PYTHON := /opt/homebrew/bin/python3
WRANGLER := node_modules/.bin/wrangler
VITEST := node_modules/.bin/vitest
# Marque posée par un `make check` vert sur un arbre propre : le commit vérifié.
# scripts/livrer.py refuse de livrer si elle ne vaut pas HEAD.
MARQUE_CHECK := .wrangler/check-ok
PORT ?= 8788

.PHONY: installer dev test check sauvegarde livrer livrer-essai sonde-prod sonde-essai _outils

installer:  ## dépendances, telles que le verrou les fixe
	npm ci

_outils:
	@test -x $(WRANGLER) -a -x $(VITEST) || { echo "node_modules incomplet : make installer d'abord."; exit 1; }

dev: _outils  ## base locale à jour, puis serveur local sur 8788 (jamais 8787, pris par un autre service)
	npm run -s db:migrate:local
	$(WRANGLER) dev --port $(PORT)

test: _outils  ## les tests, un fichier après l'autre (en parallèle, Miniflare se marche dessus sur ce Mac)
	$(VITEST) run --no-file-parallelism

check: _outils  ## tout ce qui doit passer avant de dire « fini » ; sur un arbre propre, marque le commit vérifié
	rm -f $(MARQUE_CHECK)
	npm run -s typecheck
	$(VITEST) run --no-file-parallelism
	npm run -s check:images
	@# les scripts Python se lisent sans erreur (ast, et non py_compile : pas de __pycache__ dans l'arbre)
	$(PYTHON) -B -c 'import ast, sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' scripts/sauvegarde_nuit.py scripts/livrer.py
	@etat="$$(git status --porcelain)" || { echo "git status a échoué : aucune marque posée."; exit 1; }; \
	head="$$(git rev-parse HEAD)" || { echo "git rev-parse a échoué : aucune marque posée."; exit 1; }; \
	if [ -z "$$etat" ] && [ -n "$$head" ]; then mkdir -p .wrangler && echo "$$head" > $(MARQUE_CHECK) && echo "check vert sur $${head:0:8} : livrable."; \
	else echo "check vert, mais l'arbre n'est pas propre : rien n'est livrable avant un commit et un nouveau make check."; fi

sauvegarde:  ## export horodaté de la base de PRODUCTION dans sauvegardes/ (lecture seule), ligne dans ~/Library/Logs/gites-sauvegarde.log
	$(PYTHON) scripts/sauvegarde_nuit.py --cible prod --origine manuel

livrer:  ## PRODUCTION (go de Julien), depuis main : gardes, sauvegarde, migrations distantes, déploiement, sonde
	$(PYTHON) scripts/livrer.py --cible prod

livrer-essai:  ## ESSAI, depuis n'importe quelle branche : gardes, sauvegarde de la base d'essai, migrations, déploiement avec le jeton d'essai, sonde
	$(PYTHON) scripts/livrer.py --cible essai

sonde-prod:  ## la sonde publique de la production (/api/public/health : 2xx et ok=true), une minute au plus
	$(PYTHON) scripts/livrer.py --sonde prod

sonde-essai:  ## la sonde publique de l'essai
	$(PYTHON) scripts/livrer.py --sonde essai
