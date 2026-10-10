// Retours d'action fiables (plan v4, changement 3) : le bouton se verrouille
// pendant l'envoi, puis dit « C'est fait » ou l'erreur en clair. Jamais muet.
import { t } from "@lingui/core/macro";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";

import { errorText } from "../api/client";
import { useRefresh } from "../api/hooks";
import { useToast } from "./toasts";

export type ActionState = { status: "idle" } | { status: "busy" } | { status: "done"; text: string } | { status: "error"; text: string };

export function useAction() {
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const toast = useToast();
  const refresh = useRefresh();
  async function run(fn: () => Promise<unknown>, okText: string | ((r: unknown) => string)): Promise<boolean> {
    if (state.status === "busy") return false;
    setState({ status: "busy" });
    try {
      const r = await fn();
      const text = typeof okText === "function" ? okText(r) : okText;
      setState({ status: "done", text });
      toast(text);
      await refresh();
      return true;
    } catch (e) {
      const text = errorText(e);
      setState({ status: "error", text });
      toast(text, true);
      return false;
    }
  }
  return { state, run, reset: () => setState({ status: "idle" }) };
}

export function ActionButton(props: {
  children: ReactNode;
  run: () => Promise<unknown>;
  ok: string | ((r: unknown) => string);
  className?: string;
  disabled?: boolean;
  onDone?: () => void;
  icon?: ReactNode;
  showError?: boolean;
}) {
  const { state, run } = useAction();
  const busy = state.status === "busy";
  return (
    <>
      <button
        type="button"
        className={`btn ${props.className ?? ""}${state.status === "done" ? " done" : ""}`}
        disabled={busy || props.disabled}
        aria-busy={busy}
        onClick={async () => {
          if (await run(props.run, props.ok)) props.onDone?.();
        }}
      >
        {state.status === "done" ? <IconCheck size={20} /> : props.icon}
        {busy ? t`Un instant…` : state.status === "done" ? t`C'est fait` : props.children}
      </button>
      {props.showError !== false && state.status === "error" ? <ErrorLine text={state.text} /> : null}
    </>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <div className="err" role="alert">
      <IconAlertTriangle size={20} />
      <p>{text}</p>
    </div>
  );
}
