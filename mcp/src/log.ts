// Journal du connecteur — sur stderr uniquement (stdout porte le protocole MCP).
//
// Règle : AUCUNE donnée client ici. On n'écrit que le nom de l'outil, l'issue,
// le code HTTP et la durée — jamais un nom, un e-mail, un texte de message,
// une référence de réservation ni une URL avec ses paramètres de requête.
export function logEvent(event: string, fields: Record<string, string | number | boolean> = {}): void {
  if (process.env.GITES_MCP_SILENCE === "1") return;
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`);
  process.stderr.write(`[gites-mcp] ${new Date().toISOString()} ${event}${parts.length ? " " + parts.join(" ") : ""}\n`);
}
