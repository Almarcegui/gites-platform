// Adresse e-mail masquée pour l'affichage public (page Merci) :
// « claire.dubois@example.be » → « c•••@example.be ».
//
// Assez pour que le client reconnaisse SON adresse (ou repère la faute de
// frappe dans le domaine, l'erreur la plus fréquente : « gmial.com »), pas
// assez pour qu'une personne qui tombe sur la page lise l'adresse complète.

export function maskEmail(email: string | null | undefined): string | null {
  const s = String(email ?? "").trim();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return s ? "•••" : null;
  return `${s[0]}•••${s.slice(at)}`;
}

/** Adresse acceptée pour un renvoi public : plus stricte que la forme minimale
 *  du tunnel, parce qu'elle peut être écrite sur une fiche vide. Refuse les
 *  espaces, caractères de contrôle et délimiteurs, les points en tête, en fin
 *  ou doublés, les libellés de domaine vides ou bordés d'un tiret. */
export function isDeliverableEmail(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253) return false;
  if (!labels.every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) return false;
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]!);
}
