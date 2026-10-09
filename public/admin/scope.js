// Back-office — périmètre d'une écriture mono-domaine (issue #52).
//
// Isolé sans DOM ni import pour être testé directement (même parti pris que
// `badges.js`). `app.js` s'en sert pour décider s'il faut demander le domaine
// avant une nouvelle vente ou un import elloha.

/**
 * @param {number} selectedId domaine sélectionné, `0` = « Tous les domaines »
 * @param {{id: number}[]} properties domaines connus
 * @returns {{ kind: "direct", id: number } | { kind: "ask" } | { kind: "none" }}
 *   `direct` : écrire sur ce domaine sans rien demander ; `ask` : demander ;
 *   `none` : aucun domaine connu — ne rien écrire (jamais de repli sur l'id 1).
 */
export function propertyChoice(selectedId, properties) {
  const list = Array.isArray(properties) ? properties : [];
  if (selectedId && list.some((p) => p.id === selectedId)) return { kind: "direct", id: selectedId };
  if (list.length === 0) return { kind: "none" };
  if (list.length === 1) return { kind: "direct", id: list[0].id };
  return { kind: "ask" };
}
