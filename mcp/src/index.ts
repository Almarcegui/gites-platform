#!/usr/bin/env node
// Point d'entrée stdio : `node dist/index.js`, lancé par Claude Code, Claude
// Desktop ou Jarvis. Configuration par variables d'environnement :
//   GITES_URL  (https://gites-platform.j-decartier.workers.dev, ou http://localhost:PORT)
//   GITES_ID   identifiant admin (compte de la page Utilisateurs, ou couple ADMIN_TOKEN)
//   GITES_MDP  mot de passe
//   GITES_SERVICE_KEY  à la place des deux : clé d'accès de service (Bearer svc:<clé>)
// stdout est réservé au protocole MCP ; le journal (sans donnée client) va sur stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./client.js";
import { logEvent } from "./log.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
  logEvent("demarre", { hote: new URL(cfg.baseUrl).host });
}

main().catch((e) => {
  process.stderr.write(`[gites-mcp] démarrage impossible : ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
