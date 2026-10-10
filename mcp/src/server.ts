// Assemblage du serveur MCP (sans transport — testable en mémoire).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitesClient, type GitesConfig } from "./client.js";
import type { Ctx } from "./commun.js";
import { Confirmations } from "./confirmation.js";
import { registerReadTools } from "./outils-lecture.js";
import { registerWriteTools } from "./outils-ecriture.js";
import { Referentiel } from "./referentiel.js";

export const INSTRUCTIONS = [
  "Connecteur de la plateforme de gestion des gîtes (Les Gîtes du Pré Moré : La Maison du Scieur, La Scierie, le Domaine entier ; Le Moulin de Braives).",
  "Dates au format AAAA-MM-JJ, journée de Bruxelles ; `depart` = jour du départ. Montants en euros TTC.",
  "Lecture : arrivees_departs, disponibilite, devis, fiche_reservation, reservations, messages_en_attente, paiements_en_attente, sante.",
  "Écriture (bloquer_dates, debloquer_dates, repondre_client, vente_telephone, relancer_solde) : toujours deux appels. Le premier, sans `confirmer`, renvoie un récapitulatif et un jeton ; le lire à l'utilisateur et n'appeler avec confirmer: true + jeton qu'après son accord explicite.",
  "Annulations, remboursements et tarifs ne passent pas par ce connecteur : renvoyer vers le back-office.",
].join("\n");

export function buildServer(cfg: GitesConfig, opts: { fetchImpl?: typeof fetch; now?: () => Date } = {}): McpServer {
  const client = new GitesClient(cfg, opts.fetchImpl);
  const ctx: Ctx = {
    client,
    ref: new Referentiel(client),
    confirmations: new Confirmations(),
    now: opts.now ?? (() => new Date()),
  };
  const server = new McpServer({ name: "gites", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  // Quand l'hôte sait demander une validation à l'humain (élicitation MCP),
  // la confirmation passe par lui : le modèle seul ne peut plus dire « oui ».
  ctx.elicit = async (message) => {
    if (process.env.GITES_MCP_ELICITATION === "0") return null;
    if (!server.server.getClientCapabilities()?.elicitation) return null;
    const r = await server.server.elicitInput({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: { confirmer: { type: "boolean", title: "Confirmer cette écriture", description: "Cocher pour exécuter." } },
        required: ["confirmer"],
      },
    });
    return r.action === "accept" && r.content?.confirmer === true;
  };
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}
