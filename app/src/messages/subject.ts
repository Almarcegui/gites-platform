// Objet d'une réponse : même règle que le serveur (replySubject, src/services/email.ts).
// Le serveur l'applique de toute façon ; ici le champ « Objet » montre ce qui partira.
const ctrl = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+", "g");

export function replySubject(subject: string, reference: string | null | undefined): string {
  const clean = subject.replace(ctrl, " ").replace(/\s+/g, " ").replace(/Question de [^—]+ — /i, "Question — ").trim().slice(0, 200);
  if (!reference) return clean || "Votre message";
  const ref = `[${reference}]`;
  if (clean === "") return `${ref} Votre réservation`;
  const bounded = new RegExp(`(?<![A-Za-z0-9])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
  return bounded.test(clean) ? clean : `${ref} ${clean}`;
}
