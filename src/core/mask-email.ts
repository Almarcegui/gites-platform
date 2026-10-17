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
