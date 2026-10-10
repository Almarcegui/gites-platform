// État « ménage fait » — PILOTE : gardé dans le navigateur de cet appareil
// (localStorage), faute de table serveur. Le plan v4 (fonction 1) prévoit la
// table, les routes et le lien de partage pour la personne du ménage.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "gp2_menage_fait";
const listeners = new Set<() => void>();

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let cache = read();
let snapshot = JSON.stringify(cache);

function write(next: Record<string, string>) {
  cache = next;
  snapshot = JSON.stringify(next);
  try {
    localStorage.setItem(KEY, snapshot);
  } catch {
    /* stockage indisponible : l'état vit le temps de la page */
  }
  listeners.forEach((l) => l());
}

export function useCleaningDone() {
  const snap = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
  const isDone = useCallback((key: string) => snap.includes(`"${key}"`), [snap]);
  const toggle = useCallback((key: string) => {
    const next = { ...cache };
    if (next[key]) delete next[key];
    else next[key] = new Date().toISOString();
    write(next);
  }, []);
  return { isDone, toggle, doneAt: (key: string) => cache[key] ?? null };
}

/** Pour les essais : repart d'un état vide. */
export function resetCleaningForTests() {
  write({});
}
