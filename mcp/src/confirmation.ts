// Double geste des écritures : un premier appel SANS `confirmer` renvoie un
// récapitulatif et un jeton ; seul un second appel avec les MÊMES paramètres,
// `confirmer: true` et ce jeton, écrit.
//
// Le jeton est lié à deux empreintes SHA-256 :
//  - celle des paramètres (changer une date ou un mot du message l'invalide) ;
//  - celle de l'ÉTAT montré au récapitulatif (cible résolue, destinataire,
//    montant…). À la confirmation, le récapitulatif est recalculé : si l'état a
//    bougé entre-temps (prix modifié, autre blocage visé, adresse changée),
//    l'écriture est refusée.
// Usage unique, 10 minutes, et un seul jeton vivant par demande identique : un
// second récapitulatif révoque le premier (pas de double envoi par deux jetons).

import { createHash, randomBytes } from "node:crypto";

export function digest(tool: string, params: Record<string, unknown>): string {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([k, v]) => k !== "confirmer" && k !== "jeton" && v !== undefined),
  );
  return createHash("sha256").update(tool).update("\0").update(canonical(clean)).digest("hex");
}

export function stateDigest(state: unknown): string {
  return createHash("sha256").update(canonical(state ?? null)).digest("hex");
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
  return JSON.stringify(v ?? null);
}

interface Pending {
  digest: string;
  state: string;
  expires: number;
}

export class Confirmations {
  #pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  issue(tool: string, params: Record<string, unknown>, state: unknown): string {
    this.#sweep();
    const d = digest(tool, params);
    for (const [k, v] of this.#pending) if (v.digest === d) this.#pending.delete(k);
    const jeton = randomBytes(6).toString("hex");
    this.#pending.set(jeton, { digest: d, state: stateDigest(state), expires: Date.now() + this.ttlMs });
    return jeton;
  }

  /** Consomme le jeton s'il correspond aux paramètres. Renvoie l'empreinte de
   *  l'état récapitulé, ou la raison du refus. Un jeton présenté avec d'autres
   *  paramètres n'est PAS consommé. */
  consume(tool: string, params: Record<string, unknown>, jeton: string | undefined): { state: string } | { refus: string } {
    this.#sweep();
    if (!jeton) return { refus: "jeton manquant" };
    const entry = this.#pending.get(jeton);
    if (!entry) return { refus: "jeton inconnu, déjà utilisé, remplacé par un récapitulatif plus récent, ou expiré" };
    if (entry.digest !== digest(tool, params)) return { refus: "les paramètres ne sont plus ceux du récapitulatif" };
    this.#pending.delete(jeton);
    return { state: entry.state };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#pending) if (v.expires <= now) this.#pending.delete(k);
  }
}
