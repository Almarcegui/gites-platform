// Domaine affiché : « Tous mes gîtes » ou un seul domaine. Gardé dans le
// navigateur (simple confort, pas une donnée).
import { createContext, useContext, useState, type ReactNode } from "react";

export type Scope = "all" | number;
const KEY = "gp2_scope";

function read(): Scope {
  try {
    const v = localStorage.getItem(KEY);
    if (v && /^\d+$/.test(v)) return Number(v);
  } catch {
    /* stockage indisponible */
  }
  return "all";
}

const Ctx = createContext<{ scope: Scope; setScope: (s: Scope) => void }>({ scope: "all", setScope: () => {} });

export function ScopeProvider({ children, initial }: { children: ReactNode; initial?: Scope }) {
  const [scope, set] = useState<Scope>(initial ?? read);
  const setScope = (s: Scope) => {
    set(s);
    try {
      localStorage.setItem(KEY, String(s));
    } catch {
      /* stockage indisponible */
    }
  };
  return <Ctx.Provider value={{ scope, setScope }}>{children}</Ctx.Provider>;
}

export function useScope() {
  return useContext(Ctx);
}
