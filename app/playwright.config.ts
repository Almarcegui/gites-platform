import { readFileSync } from "node:fs";

import { defineConfig } from "@playwright/test";

// Parcours minimal du pilote sur le vrai serveur local (wrangler dev lancé à
// part, données chargées par `npm run pilote:donnees`). Le mot de passe du
// compte d'essai est lu dans ../.dev.vars, jamais écrit ici.
declare const process: { env: Record<string, string | undefined> };
function pilotePassword(): string {
  try {
    const m = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^PILOTE_PASSWORD=(.*)$/m);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
process.env.PILOTE_PASSWORD ??= pilotePassword();

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: process.env.GITES_URL ?? "http://127.0.0.1:8795",
    locale: "fr-BE",
    timezoneId: "Europe/Brussels",
    // Le Chrome du Mac, s'il est là : pas de navigateur à télécharger.
    ...(process.env.PW_BUNDLED ? {} : { channel: "chrome" }),
  },
  reporter: [["list"]],
});
