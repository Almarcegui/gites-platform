"""Brancher le connecteur Gîtes sur Jarvis — exemple, à reporter à la main.

Jarvis ouvre ses sessions avec `setting_sources=["user", "project", "local"]` et
`cwd` = le vault : il charge donc le serveur « gites » déclaré dans le `.mcp.json`
du vault (bloc du README). Deux réglages suffisent ensuite.
"""

# 1) agent.py (le Bureau) — lectures pré-autorisées : Jarvis répond sans demander.
OUTILS_MCP_LECTURE_GITES = {
    f"mcp__gites__{nom}"
    for nom in (
        "arrivees_departs", "disponibilite", "devis", "fiche_reservation",
        "reservations", "messages_en_attente", "paiements_en_attente", "sante",
    )
}
# OUTILS_MCP_LECTURE = OUTILS_MCP_LECTURE | OUTILS_MCP_LECTURE_GITES

# 2) cerveau.py — les écritures restent hors de allowed_tools : `_permission`
#    les voit passer (préfixe mcp__) et répond « ask », donc Jarvis demande à voix
#    haute. Le connecteur ajoute son propre garde-fou : le premier appel ne rend
#    qu'un récapitulatif et un jeton ; seul le second, confirmer=True + jeton, écrit.
#    On peut rendre la question plus parlante :
ECRITURES_GITES = {
    "mcp__gites__bloquer_dates": "bloquer des dates",
    "mcp__gites__debloquer_dates": "lever un blocage",
    "mcp__gites__repondre_client": "envoyer un message à un client",
    "mcp__gites__vente_telephone": "créer une réservation",
    "mcp__gites__relancer_solde": "relancer un client pour son solde",
}


def decrire_ecriture_gites(nom: str, entree: dict) -> str | None:
    """À appeler au début de la branche mcp__ de `_permission`."""
    if nom not in ECRITURES_GITES:
        return None
    if not entree.get("confirmer"):
        return None  # premier appel = récapitulatif seul, rien n'est écrit : « allow » possible
    # Second appel : c'est lui qui écrit. Faire relire le récapitulatif à voix haute avant.
    return f"{ECRITURES_GITES[nom]} sur la plateforme des gîtes"


# Test rapide hors Jarvis (le SDK Python MCP, `pip install mcp`) :
#
#   import asyncio
#   from mcp import ClientSession, StdioServerParameters
#   from mcp.client.stdio import stdio_client
#
#   async def main():
#       params = StdioServerParameters(
#           command="/opt/homebrew/bin/node",  # chemin complet : `env` remplace l'environnement
#           args=["/Users/almarcegui/Documents/ClaudeVault/🔧 Dev/Gites Platform/mcp/dist/index.js"],
#           env={"GITES_URL": "https://gites-platform.j-decartier.workers.dev",
#                "GITES_ID": "jarvis", "GITES_MDP_TROUSSEAU": "gites-platform"},
#       )
#       async with stdio_client(params) as (r, w), ClientSession(r, w) as s:
#           await s.initialize()
#           res = await s.call_tool("arrivees_departs", {"periode": "ce_week_end"})
#           print(res.content[0].text)
#
#   asyncio.run(main())
