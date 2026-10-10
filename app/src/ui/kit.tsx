// Briques communes des écrans du lot 1 : page (un seul titre fort), panneau
// latéral (fiche ouverte depuis une liste), boîte de saisie, garde
// « modifications non enregistrées », sections repliées, choix du domaine.
//
// Règles tenues ici une fois pour toutes :
// - un panneau avec une saisie en cours ne se ferme ni au clic à côté ni à
//   Échap ; la croix demande « fermer sans enregistrer ? » ;
// - une page avec des modifications non enregistrées retient la navigation
//   (et le rechargement) tant qu'on n'a pas choisi.
import { Trans, useLingui } from "@lingui/react/macro";
import { Drawer, Menu, Modal } from "@mantine/core";
import { IconChevronRight, IconDots, IconDownload } from "@tabler/icons-react";
import { Link, useBlocker } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { authHeader, errorText } from "../api/client";
import { useProperties } from "../api/hooks";
import type { Property } from "../api/types";
import { ErrorLine } from "../lib/action";
import { useScope } from "../lib/scope";
import { useToast } from "../lib/toasts";
import { useLayout } from "../lib/useLayout";

// --- page ---------------------------------------------------------------------

/** Un écran : un titre, une phrase qui dit à quoi il sert, les outils à droite. */
export function Page({ title, lead, tools, back, children, width = 980 }: { title: string; lead?: ReactNode; tools?: ReactNode; back?: boolean; children: ReactNode; width?: number }) {
  return (
    <div className="pg" style={{ maxWidth: width }}>
      {back ? <BackToSettings /> : null}
      <div className="head">
        <h1 className="title">{title}</h1>
        {tools ? <div className="tools">{tools}</div> : null}
      </div>
      {lead ? <p className="lead">{lead}</p> : null}
      {children}
    </div>
  );
}

function BackToSettings() {
  return (
    <Link className="crumb" to="/reglages">
      <IconChevronRight size={18} style={{ transform: "rotate(180deg)" }} />
      <Trans>Réglages</Trans>
    </Link>
  );
}

/** Un bloc d'écran : un sous-titre, et ce qui va dessous. */
export function Section({ title, hint, tools, children, id }: { title: string; hint?: ReactNode; tools?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="blk" aria-labelledby={id}>
      <div className="blk-h">
        <h2 className="sub" id={id}>
          {title}
        </h2>
        {tools ? <div className="tools">{tools}</div> : null}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/** Ce qui est secondaire se replie. */
export function Fold({ title, count, children, open }: { title: string; count?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary>
        <IconChevronRight size={22} />
        {title}
        {count != null ? <small>{count}</small> : null}
      </summary>
      <div className="fold-b">{children}</div>
    </details>
  );
}

export function Loading({ text }: { text?: string }) {
  const { t } = useLingui();
  return <p className="loading">{text ?? t`Chargement…`}</p>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// --- panneau latéral ------------------------------------------------------------

export interface MoreItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** Fiche ouverte depuis une liste ou une case : à droite à l'ordinateur,
 *  plein écran au téléphone. En-tête, actions principales, le reste sous
 *  « Plus », le détail en sections repliées. */
export function SidePanel(props: {
  opened: boolean;
  onClose: () => void;
  label: string;
  title: ReactNode;
  top?: ReactNode;
  pill?: ReactNode;
  actions?: ReactNode;
  more?: MoreItem[];
  dirty?: boolean;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const layout = useLayout();
  const [asking, setAsking] = useState(false);
  const more = (props.more ?? []).filter((m) => !m.hidden);
  const tryClose = () => (props.dirty ? setAsking(true) : props.onClose());
  return (
    <Drawer
      opened={props.opened}
      onClose={tryClose}
      position="right"
      size={layout === "A" ? 520 : "100%"}
      title={<span className="sr">{props.label}</span>}
      padding="md"
      closeOnClickOutside={!props.dirty}
      closeOnEscape={!props.dirty}
      closeButtonProps={{ "aria-label": t`Fermer`, size: "lg" }}
    >
      <div className="p-head">
        {props.top ? <div className="p-top">{props.top}</div> : null}
        <h2>{props.title}</h2>
        {props.pill}
      </div>
      <div className="p-body">
        {props.actions ? <div className="p-acts">{props.actions}</div> : null}
        {more.length ? (
          <div className="more">
            <Menu width="target" position="bottom" shadow="md">
              <Menu.Target>
                <button type="button" className="btn wide">
                  <IconDots size={22} />
                  <Trans>Plus</Trans>
                </button>
              </Menu.Target>
              <Menu.Dropdown>
                {more.map((m) => (
                  <Menu.Item key={m.label} style={{ minHeight: 44 }} color={m.danger ? "red" : undefined} onClick={m.onClick}>
                    {m.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </div>
        ) : null}
        {props.children}
      </div>
      <Confirm
        open={asking}
        title={t`Fermer sans enregistrer ?`}
        text={t`Ce que vous avez saisi dans cette fiche sera perdu.`}
        yes={t`Fermer sans enregistrer`}
        no={t`Continuer la saisie`}
        danger
        onYes={() => {
          setAsking(false);
          props.onClose();
        }}
        onNo={() => setAsking(false)}
      />
    </Drawer>
  );
}

// --- boîtes ----------------------------------------------------------------------

/** Boîte de saisie : jamais fermée au clic à côté. */
export function Box({ open, onClose, title, children, size = "lg" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; size?: string }) {
  const layout = useLayout();
  return (
    <Modal opened={open} onClose={onClose} title={<b style={{ fontSize: 20 }}>{title}</b>} closeOnClickOutside={false} centered fullScreen={layout === "B"} size={size} zIndex={400}>
      {children}
    </Modal>
  );
}

/** Une vraie question, à la place de window.confirm. */
export function Confirm(props: { open: boolean; title: string; text?: ReactNode; yes: string; no?: string; danger?: boolean; busy?: boolean; yesDisabled?: boolean; onYes: () => void; onNo: () => void; children?: ReactNode }) {
  const { t } = useLingui();
  return (
    <Modal opened={props.open} onClose={props.onNo} title={<b style={{ fontSize: 20 }}>{props.title}</b>} closeOnClickOutside={false} centered size="md" zIndex={500}>
      {props.text ? <p className="lead">{props.text}</p> : null}
      {props.children}
      <div className="acts" style={{ marginTop: 16 }}>
        <button type="button" className={`btn pri${props.danger ? " red" : ""}`} disabled={props.busy || props.yesDisabled} onClick={props.onYes}>
          {props.busy ? t`Un instant…` : props.yes}
        </button>
        <button type="button" className="btn ghost" onClick={props.onNo}>
          {props.no ?? t`Annuler`}
        </button>
      </div>
    </Modal>
  );
}

// --- garde « modifications non enregistrées » ----------------------------------------

/** Retient la navigation vers un autre écran (et le rechargement) tant que
 *  `dirty` est vrai. Ouvrir une fiche (?resa=) sur le même écran ne compte pas. */
export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const { t } = useLingui();
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && current.pathname !== next.pathname,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  return (
    <Confirm
      open={blocker.status === "blocked"}
      title={t`Partir sans enregistrer ?`}
      text={t`Des modifications de cette page ne sont pas enregistrées. Si vous partez maintenant, elles seront perdues.`}
      yes={t`Partir sans enregistrer`}
      no={t`Rester sur la page`}
      danger
      onYes={() => blocker.proceed?.()}
      onNo={() => blocker.reset?.()}
    />
  );
}

/** Barre « Enregistrer » d'une page : un seul bouton, visible dès qu'il y a
 *  quelque chose à enregistrer. */
export function SaveBar({ dirty, busy, error, onSave, onReset, label }: { dirty: boolean; busy: boolean; error?: string | null; onSave: () => void; onReset: () => void; label?: string }) {
  const { t } = useLingui();
  return (
    <>
      <UnsavedGuard dirty={dirty} />
      {dirty || busy ? (
        <div className="savebar on" role="region" aria-label={t`Enregistrement`}>
          <p>{t`Modifications non enregistrées.`}</p>
          <button type="button" className="btn ghost" onClick={onReset} disabled={busy}>
            <Trans>Annuler les modifications</Trans>
          </button>
          <button type="button" className="btn pri" onClick={onSave} disabled={busy} aria-busy={busy}>
            {busy ? t`Un instant…` : (label ?? t`Enregistrer`)}
          </button>
        </div>
      ) : null}
      {error ? <ErrorLine text={error} /> : null}
    </>
  );
}

// --- domaine de travail -------------------------------------------------------------

/** Les réglages d'un domaine se font domaine par domaine : en « Tous mes
 *  gîtes », l'écran propose de choisir lequel, sans toucher au sélecteur. */
export function useWorkingProperty(): { property: Property | undefined; properties: Property[]; picker: ReactNode } {
  const { t } = useLingui();
  const { scope } = useScope();
  const { data: properties = [] } = useProperties();
  const [local, setLocal] = useState<number | null>(null);
  useEffect(() => setLocal(null), [scope]);
  const fixed = scope === "all" ? null : properties.find((p) => p.id === scope);
  const property = fixed ?? properties.find((p) => p.id === local) ?? properties[0];
  const picker =
    !fixed && properties.length > 1 ? (
      <div className="chips" role="group" aria-label={t`Domaine réglé`}>
        {properties.map((p) => (
          <button key={p.id} type="button" className="chip" aria-pressed={property?.id === p.id} onClick={() => setLocal(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
    ) : null;
  return { property, properties, picker };
}

// --- exports CSV -----------------------------------------------------------------

/** Télécharge un export CSV de l'API (la session part dans l'en-tête, pas
 *  dans l'adresse). */
export function DownloadButton({ path, query, filename, children }: { path: string; query?: Record<string, string | number | undefined>; filename: string; children: ReactNode }) {
  const { t } = useLingui();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const url = new URL(`/api/admin${path}`, window.location.origin);
          for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
          const auth = authHeader();
          const res = await fetch(url, { headers: auth ? { authorization: auth } : {} });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ? body.error.charAt(0).toUpperCase() + body.error.slice(1) + "." : t`L'export n'a pas pu être préparé.`);
          }
          const blob = await res.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          a.click();
          URL.revokeObjectURL(a.href);
          toast(t`C'est fait. Fichier ${filename} téléchargé.`);
        } catch (e) {
          toast(errorText(e), true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <IconDownload size={20} />
      {busy ? t`Un instant…` : children}
    </button>
  );
}

// --- montants ---------------------------------------------------------------------

/** « 25,50 » → 2550 ; vide ou illisible → null. */
export function parseEuros(v: string | number | null | undefined): number | null {
  if (v === "" || v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function centsToEuros(c: number | null | undefined): number | string {
  return c == null ? "" : c / 100;
}

/** Date et heure SQL (« 2026-10-10 14:32:00 ») → « 10/10/2026 à 14 h 32 ». */
export function sqlWhen(s: string | null | undefined): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return s.slice(0, 10);
  return `${m[3]}/${m[2]}/${m[1]} à ${Number(m[4])} h ${m[5]}`;
}
