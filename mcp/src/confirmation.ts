// Double geste des écritures : un premier appel SANS `confirmer` renvoie un
// récapitulatif et un jeton ; seul un second appel avec les MÊMES paramètres,
// `confirmer: true` et ce jeton, écrit. Le jeton est lié au contenu exact de la
// demande (empreinte SHA-256), à usage unique et valable 10 minutes : un
// `confirmer: true` envoyé d'emblée, ou après avoir changé une date ou un mot
// du message, est refusé.

import { createHash, randomBytes } from "node:crypto";

export function digest(tool: string, params: Record<string, unknown>): string {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([k, v]) => k !== "confirmer" && k !== "jeton" && v !== undefined),
  );
  return createHash("sha256").update(tool).update("\0").update(canonical(clean)).digest("hex");
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export class Confirmations {
  #pending = new Map<string, { digest: string; expires: number }>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  issue(tool: string, params: Record<string, unknown>): string {
    this.#sweep();
    const jeton = randomBytes(4).toString("hex");
    this.#pending.set(jeton, { digest: digest(tool, params), expires: Date.now() + this.ttlMs });
    return jeton;
  }

  /** Consomme le jeton s'il correspond ; renvoie la raison du refus sinon. */
  consume(tool: string, params: Record<string, unknown>, jeton: string | undefined): string | null {
    this.#sweep();
    if (!jeton) return "jeton manquant";
    const entry = this.#pending.get(jeton);
    if (!entry) return "jeton inconnu, déjà utilisé ou expiré";
    if (entry.digest !== digest(tool, params)) return "les paramètres ne sont plus ceux du récapitulatif";
    this.#pending.delete(jeton);
    return null;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#pending) if (v.expires <= now) this.#pending.delete(k);
  }
}
