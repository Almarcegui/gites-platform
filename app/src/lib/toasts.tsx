// Avis « C'est fait » / erreur en clair, en bas de l'écran (maquettes A et B).
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  text: string;
  bad: boolean;
}
type Push = (text: string, bad?: boolean) => void;
const Ctx = createContext<Push>(() => {});

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback<Push>((text, bad = false) => {
    const id = ++seq;
    setItems((xs) => [...xs, { id, text, bad }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), bad ? 7000 : 4200);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.bad ? " bad" : ""}`}>
            {t.bad ? <IconAlertTriangle size={22} /> : <IconCheck size={22} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): Push {
  return useContext(Ctx);
}
