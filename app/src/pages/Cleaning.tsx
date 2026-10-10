// Ménage (plan v4, fonction 1) : un ménage par départ, avec l'heure, la
// prochaine arrivée et le nombre de voyageurs. Les tâches vivent sur le
// serveur (migration 0022) : « fait » se voit sur tous les appareils, et la
// personne du ménage coche depuis son propre lien, sans compte.
import { Trans, useLingui } from "@lingui/react/macro";
import { Select, Textarea, TextInput } from "@mantine/core";
import { IconCopy, IconLink, IconPencil } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import { useProperties, useTasks } from "../api/hooks";
import type { Task, TaskShareLink } from "../api/types";
import { ErrorLine, useAction } from "../lib/action";
import { addDays, hourLabel, longDate, titleDate, todayBrussels } from "../lib/dates";
import { toCleaningItem, type CleaningItem } from "../lib/tasks";
import { Box, Confirm, sqlWhen } from "../ui/kit";

const HORIZON = 21;

export function CleaningPage() {
  const { t } = useLingui();
  const today = todayBrussels();
  const q = useTasks(addDays(today, -1), addDays(today, HORIZON + 1));
  // Hier : seulement ce qui n'a pas été coché. Ensuite, tout.
  const items = (q.data ?? []).map((x) => toCleaningItem(x)).filter((c) => c.date >= today || !c.done);
  const byDay = new Map<string, CleaningItem[]>();
  for (const k of items) byDay.set(k.date, [...(byDay.get(k.date) ?? []), k]);
  const [editing, setEditing] = useState<Task | null>(null);

  return (
    <div className="pg" style={{ maxWidth: 880 }}>
      <div className="head">
        <h1 className="title">
          <Trans>Ménage</Trans>
        </h1>
      </div>
      <p className="lead">{t`Chaque départ crée un ménage. La liste se met à jour toute seule, sur les trois prochaines semaines. Ce qui est coché ici se voit partout, et sur le lien de la personne du ménage.`}</p>
      {q.error ? <ErrorLine text={t`La liste n'a pas pu être lue. Rechargez la page.`} /> : null}
      {q.isLoading ? <p className="loading">{t`Chargement…`}</p> : null}
      {q.data && items.length === 0 ? (
        <div className="empty">
          <h3>{t`Aucun ménage prévu`}</h3>
          <p>{t`Aucun départ dans les trois prochaines semaines.`}</p>
        </div>
      ) : null}
      {[...byDay].map(([day, list]) => (
        <section key={day} aria-label={longDate(day)}>
          <h2 className="mday">{day === today ? t`Aujourd'hui, ${longDate(day)}` : day < today ? t`Hier, pas encore coché` : titleDate(day)}</h2>
          {list.map((c) => (
            <CleaningJob key={c.key} c={c} onEdit={() => setEditing(c.task)} />
          ))}
        </section>
      ))}
      <ShareLinks />
      {editing ? <EditBox task={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function CleaningJob({ c, onEdit }: { c: CleaningItem; onEdit: () => void }) {
  const { t } = useLingui();
  return (
    <article className="job">
      <h3>{c.isComposite ? t`Les deux maisons, après ${c.unitName}` : c.unitName}</h3>
      <dl className="when">
        <dt>{t`Départ`}</dt>
        <dd>{hourLabel(c.time)}</dd>
        {c.next ? (
          c.tight ? (
            <>
              <dt>{t`À finir avant`}</dt>
              <dd className="tight">{t`${hourLabel(c.next.checkinTime)}, nouveaux voyageurs le jour même`}</dd>
            </>
          ) : (
            <>
              <dt>{t`Prochaine arrivée`}</dt>
              <dd>
                {longDate(c.next.checkin)}
                {c.next.unitName && c.next.unitName !== c.unitName ? `, ${c.next.unitName}` : ""}
              </dd>
            </>
          )
        ) : (
          <>
            <dt>{t`Prochaine arrivée`}</dt>
            <dd>{t`aucune de prévue`}</dd>
          </>
        )}
        {c.next ? (
          <>
            <dt>{t`Pour`}</dt>
            <dd>{t`${c.next.persons} personnes`}</dd>
          </>
        ) : null}
        {c.task.assignee ? (
          <>
            <dt>{t`Qui`}</dt>
            <dd>{c.task.assignee}</dd>
          </>
        ) : null}
        {c.task.note ? (
          <>
            <dt>{t`Note`}</dt>
            <dd style={{ fontWeight: 400 }}>{c.task.note}</dd>
          </>
        ) : null}
      </dl>
      <TaskTick c={c} />
      <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={onEdit}>
        <IconPencil size={20} />
        {t`Qui s'en occupe, note`}
      </button>
    </article>
  );
}

/** La case « Ménage fait », écrite sur le serveur. */
export function TaskTick({ c, kColor }: { c: CleaningItem; kColor?: string }) {
  const { t } = useLingui();
  const a = useAction();
  const done = c.done;
  const by = c.task.doneBy?.startsWith("lien:") ? c.task.doneBy.slice(5) : c.task.doneBy;
  return (
    <>
      <button
        type="button"
        className="tick"
        role="checkbox"
        aria-checked={done}
        aria-busy={a.state.status === "busy"}
        disabled={a.state.status === "busy"}
        style={kColor ? { ["--k" as string]: kColor } : undefined}
        onClick={() => a.run(() => api(`/tasks/${c.task.id}`, { method: "PATCH", body: { status: done ? "a_faire" : "fait" } }), done ? t`C'est fait. Ménage remis à faire.` : t`C'est fait. Ménage noté comme fait.`)}
      >
        <span className="box">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7" />
          </svg>
        </span>
        <span>
          {t`Ménage fait`}
          <small>{a.state.status === "busy" ? t`Un instant…` : done ? (by ? t`noté par ${by}` : t`noté`) : t`touchez quand la maison est prête`}</small>
        </span>
      </button>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </>
  );
}

function EditBox({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useLingui();
  const [who, setWho] = useState(task.assignee ?? "");
  const [note, setNote] = useState(task.note ?? "");
  const a = useAction();
  return (
    <Box open onClose={onClose} title={t`Ménage, ${task.unitName}`} size="md">
      <TextInput size="md" label={t`Qui s'en occupe`} description={t`un prénom suffit, il s'affiche sur le lien de partage`} maxLength={60} value={who} onChange={(e) => setWho(e.currentTarget.value)} />
      <Textarea mt="md" size="md" autosize minRows={3} label={t`Note pour le ménage`} description={t`visible sur le lien de partage : n'y mettez pas le nom des voyageurs`} maxLength={500} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={a.state.status === "busy"}
          onClick={async () => {
            if (await a.run(() => api(`/tasks/${task.id}`, { method: "PATCH", body: { assignee: who.trim() || null, note: note.trim() || null } }), t`C'est fait. Ménage mis à jour.`)) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
    </Box>
  );
}

function ShareLinks() {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const q = useQuery({ queryKey: ["task-links"], queryFn: () => api<{ links: TaskShareLink[] }>("/task-links").then((r) => r.links) });
  const [label, setLabel] = useState("");
  const [pid, setPid] = useState<string>("all");
  const [made, setMade] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<TaskShareLink | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useAction();
  const revoke = useAction();
  useEffect(() => setCopied(false), [made]);
  const live = (q.data ?? []).filter((l) => !l.revokedAt);
  const where = (id: number | null) => (id == null ? t`tous les gîtes` : (properties.find((p) => p.id === id)?.name ?? ""));
  return (
    <section className="blk" aria-labelledby="h-links" style={{ marginTop: 32 }}>
      <h2 className="sub" id="h-links">
        <IconLink size={22} style={{ verticalAlign: "-4px" }} /> <Trans>Lien pour la personne du ménage</Trans>
      </h2>
      <p className="hint">{t`Un lien à envoyer par SMS : elle voit les ménages des deux semaines à venir et coche « fait », sans compte ni mot de passe. Aucun nom de voyageur n'y apparaît. Un lien se coupe à tout moment.`}</p>
      {q.error ? <ErrorLine text={t`Les liens n'ont pas pu être lus.`} /> : null}
      {live.length ? (
        <div className="panel">
          {live.map((l) => (
            <div key={l.id} className="list-row two">
              <span>
                <b>{l.label}</b>
                <small>{[where(l.propertyId), l.lastUsedAt ? t`ouvert ${sqlWhen(l.lastUsedAt)}` : t`jamais ouvert`].join(", ")}</small>
              </span>
              <button type="button" className="btn" onClick={() => setRevoking(l)}>
                {t`Couper`}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid2" style={{ marginTop: 12 }}>
        <TextInput size="md" label={t`Pour qui`} placeholder={t`Par exemple : Martine`} maxLength={60} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        <Select size="md" label={t`Quels gîtes`} allowDeselect={false} value={pid} onChange={(v) => setPid(v ?? "all")} data={[{ value: "all", label: t`Tous mes gîtes` }, ...properties.map((p) => ({ value: String(p.id), label: p.name }))]} />
      </div>
      <button
        type="button"
        className="btn pri"
        style={{ marginTop: 12 }}
        disabled={label.trim().length < 2 || create.state.status === "busy"}
        onClick={async () => {
          await create.run(async () => {
            const r = await api<{ url: string }>("/task-links", { method: "POST", body: { label: label.trim(), propertyId: pid === "all" ? null : Number(pid) } });
            setMade(r.url);
            setLabel("");
            return r;
          }, t`C'est fait. Lien créé.`);
        }}
      >
        {create.state.status === "busy" ? t`Un instant…` : t`Créer un lien`}
      </button>
      {create.state.status === "error" ? <ErrorLine text={create.state.text} /> : null}
      <Box open={made != null} onClose={() => setMade(null)} title={t`Le lien à envoyer`} size="md">
        <p className="lead">{t`Copiez-le maintenant : il ne sera plus montré. S'il se perd, coupez-le et créez-en un autre.`}</p>
        <TextInput size="md" readOnly value={made ?? ""} aria-label={t`Adresse du lien`} onFocus={(e) => e.currentTarget.select()} />
        <div className="acts" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn pri"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(made ?? "");
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <IconCopy size={20} />
            {copied ? t`Copié` : t`Copier le lien`}
          </button>
          <button type="button" className="btn ghost" onClick={() => setMade(null)}>
            <Trans>Fermer</Trans>
          </button>
        </div>
      </Box>
      <Confirm
        open={revoking != null}
        title={t`Couper le lien de ${revoking?.label ?? ""} ?`}
        text={t`Le lien ne s'ouvrira plus. Les ménages déjà cochés restent cochés.`}
        yes={t`Couper le lien`}
        danger
        busy={revoke.state.status === "busy"}
        onNo={() => setRevoking(null)}
        onYes={async () => {
          await revoke.run(() => api(`/task-links/${revoking!.id}`, { method: "DELETE" }), t`C'est fait. Lien coupé.`);
          setRevoking(null);
        }}
      />
    </section>
  );
}
