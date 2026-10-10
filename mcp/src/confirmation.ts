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
// Usage unique, 10 minutes, et UN SEUL jeton vivant par outil : tout nouveau
// récapitulatif du même outil révoque le précédent (pas de double envoi par deux
// jetons, même pour deux textes qui ne diffèrent que d'un espace).
//
// Une écriture dont l'issue est inconnue (coupure, 5xx) est mémorisée 30 minutes :
// un nouveau récapitulatif de la même demande est refusé tant que l'utilisateur
// n'a pas vérifié au back-office et ajouté `apres_verification: true`.

import { createHash, randomBytes } from "node:crypto";

const CONTROL_KEYS = new Set(["confirmer", "jeton", "apres_verification"]);

export function digest(tool: string, params: Record<string, unknown>): string {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([k, v]) => !CONTROL_KEYS.has(k) && v !== undefined),
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
  tool: string;
  digest: string;
  state: string;
  expires: number;
}

export class Confirmations {
  #pending = new Map<string, Pending>();
  #unknown = new Map<string, number>(); // empreinte → horodatage de l'issue inconnue

  constructor(private readonly ttlMs = 10 * 60_000) {}

  issue(tool: string, params: Record<string, unknown>, state: unknown): string {
    this.#sweep();
    const d = digest(tool, params);
    for (const [k, v] of this.#pending) if (v.tool === tool) this.#pending.delete(k);
    const jeton = randomBytes(6).toString("hex");
    this.#pending.set(jeton, { tool, digest: d, state: stateDigest(state), expires: Date.now() + this.ttlMs });
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

  markUnknown(tool: string, params: Record<string, unknown>): void {
    this.#unknown.set(digest(tool, params), Date.now());
  }

  /** Heure (ms) d'une tentative identique à l'issue inconnue, dans les 30 dernières minutes. */
  unknownSince(tool: string, params: Record<string, unknown>): number | null {
    const at = this.#unknown.get(digest(tool, params));
    if (at === undefined) return null;
    if (Date.now() - at > 30 * 60_000) {
      this.#unknown.delete(digest(tool, params));
      return null;
    }
    return at;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#pending) if (v.expires <= now) this.#pending.delete(k);
  }
}
