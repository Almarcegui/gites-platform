// Mise en route : les démarches légales et techniques, section par section,
// avec où on en est. Changer l'état d'une ligne s'enregistre tout de suite ;
// une ligne s'ouvre en panneau pour y ajouter une remarque.
import { useLingui } from "@lingui/react/macro";
import { Select, Textarea } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { ChecklistItem } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { Loading, Page, Section, SidePanel } from "../../ui/kit";

type Status = ChecklistItem["status"];
const DONE: Status[] = ["fait", "verifie", "n_a"];

function useWords() {
  const { t } = useLingui();
  const status = (s: Status) => ({ a_faire: t`À faire`, en_cours: t`En cours`, fait: t`Fait`, verifie: t`Vérifié, pièce en main`, n_a: t`Sans objet` })[s];
  const tone = (s: Status) => (s === "a_faire" ? "annulee" : s === "en_cours" ? "option" : s === "n_a" ? "muted-pill" : "soldee");
  const owner = (o: ChecklistItem["owner"]) => ({ papa: t`Papa`, julien: t`Julien`, claude: t`automatique` })[o];
  return { status, tone, owner };
}

export function StartupPage() {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["checklist"], queryFn: () => api<{ items: ChecklistItem[] }>("/checklist").then((r) => r.items) });
  const [open, setOpen] = useState<ChecklistItem | null>(null);
  const w = useWords();
  const items = q.data ?? [];
  const done = items.filter((i) => DONE.includes(i.status)).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const sections: { name: string; items: ChecklistItem[] }[] = [];
  for (const it of items) {
    let s = sections.find((x) => x.name === it.section);
    if (!s) sections.push((s = { name: it.section, items: [] }));
    s.items.push(it);
  }
  return (
    <Page title={t`Mise en route`} back lead={t`Ce qu'il faut régler avant et pendant le lancement. « Fait » : la démarche est accomplie ; « Vérifié » : c'est confirmé, pièce en main.`}>
      {q.error ? <ErrorLine text={t`La liste n'a pas pu être lue.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {items.length ? (
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t`Avancement`}>
          <p>
            <b className="num">
              {done} / {items.length}
            </b>{" "}
            {t`réglés`}
          </p>
          <div className="track">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}
      {sections.map((s) => (
        <Section key={s.name} title={s.name} hint={t`${s.items.filter((i) => DONE.includes(i.status)).length} sur ${s.items.length} réglés`}>
          <div className="panel" role="list">
            {s.items.map((i) => (
              <button key={i.id} type="button" role="listitem" className={`list-row two${DONE.includes(i.status) ? " off" : ""}`} onClick={() => setOpen(i)}>
                <span>
                  <b>{i.label}</b>
                  <small>{[t`pour ${w.owner(i.owner)}`, i.note].filter(Boolean).join(", ")}</small>
                </span>
                <span className={`pill ${w.tone(i.status)}`}>{w.status(i.status)}</span>
              </button>
            ))}
          </div>
        </Section>
      ))}
      {open ? <ItemPanel item={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function ItemPanel({ item, onClose }: { item: ChecklistItem; onClose: () => void }) {
  const { t } = useLingui();
  const w = useWords();
  const [status, setStatus] = useState<Status>(item.status);
  const [extra, setExtra] = useState("");
  const a = useAction();
  const dirty = status !== item.status || extra.trim().length > 0;
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Démarche`}
      top={item.section}
      title={item.label}
      pill={<span className={`pill ${w.tone(item.status)}`}>{w.status(item.status)}</span>}
      dirty={dirty}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!dirty || a.state.status === "busy"}
          onClick={async () => {
            const body: { status?: Status; note?: string } = {};
            if (status !== item.status) body.status = status;
            if (extra.trim()) body.note = (item.note ? item.note + " — " : "") + extra.trim();
            if (await a.run(() => api(`/checklist/${item.id}`, { method: "PATCH", body }), t`C'est fait. Démarche mise à jour.`)) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
        </button>
      }
    >
      <p className="lead">{t`Pour ${w.owner(item.owner)}.`}</p>
      {item.url ? (
        <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer" style={{ marginBottom: 14 }}>
          <IconExternalLink size={20} />
          {t`Ouvrir la page de la démarche`}
        </a>
      ) : null}
      <Select
        size="md"
        label={t`Où on en est`}
        allowDeselect={false}
        value={status}
        onChange={(v) => setStatus((v as Status) ?? status)}
        data={(["a_faire", "en_cours", "fait", "verifie", "n_a"] as Status[]).map((s) => ({ value: s, label: w.status(s) }))}
      />
      {item.note ? <p className="note">{item.note}</p> : null}
      <Textarea mt="sm" size="md" autosize minRows={2} label={t`Ajouter une remarque`} description={t`numéro obtenu, date, qui a appelé…`} value={extra} onChange={(e) => setExtra(e.currentTarget.value)} />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </SidePanel>
  );
}
