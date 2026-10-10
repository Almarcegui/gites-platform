// Recherche par téléphone (plan v4, fonction 5).
//
// Les numéros sont saisis n'importe comment : « +32 475 12 34 56 »,
// « 0475/12.34.56 », « 0032475123456 ». On compare des CHIFFRES, et pour un
// numéro belge on retire l'indicatif ou le 0 de tête : il reste le numéro
// national sans préfixe (« 475123456 »), qu'on cherche à l'intérieur des
// chiffres du numéro enregistré. « 0475 12 » trouve donc « +32 475 12 34 56 ».

/** Chiffres seuls d'une saisie. */
export function phoneDigits(s: string): string {
  return s.replace(/\D+/g, "");
}

/** Une recherche ressemble-t-elle à un numéro ? Que des chiffres et des
 *  séparateurs usuels, et au moins 4 chiffres (« 2026 » reste une année
 *  possible : la recherche par référence continue de jouer en parallèle). */
export function looksLikePhone(q: string): boolean {
  const s = q.trim();
  return /^[+\d][\d\s./()-]*$/.test(s) && phoneDigits(s).length >= 4;
}

/** Cœur comparable d'un numéro, sans indicatif belge ni 0 de tête.
 *  Null si la saisie n'est pas un numéro. */
export function phoneCore(q: string): string | null {
  if (!looksLikePhone(q)) return null;
  const s = q.trim();
  let d = phoneDigits(s);
  if (d.startsWith("0032")) d = d.slice(4);
  else if (s.startsWith("+32")) d = d.slice(2);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);
  return d.length >= 3 ? d : null;
}

/** Expression SQL : les chiffres seuls d'une colonne de téléphone. Écrite ici
 *  une fois (et non recopiée dans chaque requête) : `col` est toujours un nom
 *  de colonne écrit dans le code, jamais une donnée. */
export function sqlPhoneDigits(col: string): string {
  let e = `COALESCE(${col}, '')`;
  for (const ch of [" ", ".", "/", "-", "(", ")", "+"]) e = `REPLACE(${e}, '${ch}', '')`;
  return e;
}
