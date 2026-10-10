// Modèles de réponse (plan v4, fonction 2) : les textes proposés dans Messages
// et dans la fiche réservation. Une ligne par modèle, sa fiche en panneau.
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Select, Switch, Textarea, TextInput } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { api } from "../../api/client";
import { useProperties } from "../../api/hooks";
import type { MessageTemplate } from "../../api/types";
import { ErrorLine, useAction } from "../../lib/action";
import { fillTemplate, TEMPLATE_VARIABLES } from "../../lib/templates";
import { Confirm, Empty, Loading, Page, Section, SidePanel } from "../../ui/kit";

const LANG: Record<MessageTemplate["lang"], string> = { fr: "français", nl: "néerlandais", en: "anglais" };

/** Exemple de remplissage montré sous le texte : le résultat se lit avant l'envoi. */
const SAMPLE = { firstName: "Claire", unitName: "La Scierie", arrival: "samedi 17 octobre", checkinTime: "16 h", checkoutTime: "10 h", balance: "450,00 €", signature: "Les Gîtes du Pré Moré" };

export function TemplatesPage() {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const q = useQuery({ queryKey: ["templates", "all", "admin"], queryFn: () => api<{ templates: MessageTemplate[] }>("/message-templates").then((r) => r.templates) });
  const [open, setOpen] = useState<MessageTemplate | "new" | null>(null);
  const where = (id: number | null) => (id == null ? t`tous les gîtes` : (properties.find((p) => p.id === id)?.name ?? ""));
  return (
    <Page title={t`Modèles de réponse`} back lead={t`Les textes proposés quand vous répondez à un client, dans Messages et dans la fiche réservation. Les mots entre accolades se remplissent tout seuls avec la réservation.`}>
      {q.error ? <ErrorLine text={t`Les modèles n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <Section
          title={t`Modèles`}
          tools={
            <button type="button" className="btn pri" onClick={() => setOpen("new")}>
              <IconPlus size={20} />
              <Trans>Nouveau modèle</Trans>
            </button>
          }
        >
          {q.data.length === 0 ? (
            <Empty title={t`Aucun modèle`} />
          ) : (
            <div className="panel">
              {q.data.map((m) => (
                <button key={m.id} type="button" className={`list-row two${m.active ? "" : " off"}`} onClick={() => setOpen(m)}>
                  <span>
                    <b>{m.name}</b>
                    <small>{[LANG[m.lang], where(m.propertyId), m.active ? "" : t`en pause`].filter(Boolean).join(", ")}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>
      ) : null}
      {open ? <TemplatePanel template={open === "new" ? null : open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function TemplatePanel({ template, onClose }: { template: MessageTemplate | null; onClose: () => void }) {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const init = useMemo(
    () => ({
      name: template?.name ?? "",
      lang: template?.lang ?? ("fr" as MessageTemplate["lang"]),
      body: template?.body ?? t`Bonjour {prenom},\n\n\n\nÀ bientôt,\n{signature}`,
      pid: template?.propertyId == null ? "all" : String(template.propertyId),
      sort: (template?.sortOrder ?? 50) as number | string,
      active: template?.active ?? true,
    }),
    [template, t],
  );
  const [v, setV] = useState(init);
  const [asking, setAsking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const a = useAction();
  const del = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(init);
  const valid = v.name.trim().length >= 2 && v.body.trim().length >= 2;
  const body = { name: v.name.trim(), lang: v.lang, body: v.body, propertyId: v.pid === "all" ? null : Number(v.pid), sortOrder: Number(v.sort) || 0, active: v.active };
  const insert = (key: string) => {
    const el = area.current;
    const token = `{${key}}`;
    if (!el) return setV({ ...v, body: v.body + token });
    const start = el.selectionStart ?? v.body.length;
    const end = el.selectionEnd ?? start;
    setV({ ...v, body: v.body.slice(0, start) + token + v.body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Modèle de réponse`}
      top={t`Modèle de réponse`}
      title={v.name.trim() || t`Nouveau modèle`}
      dirty={dirty}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!valid || (!dirty && !!template) || a.state.status === "busy"}
          onClick={async () => {
            const ok = await a.run(() => (template ? api(`/message-templates/${template.id}`, { method: "PATCH", body }) : api("/message-templates", { method: "POST", body })), template ? t`C'est fait. Modèle enregistré.` : t`C'est fait. Modèle créé.`);
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : template ? t`Enregistrer` : t`Créer`}
        </button>
      }
      more={template ? [{ label: t`Supprimer le modèle`, danger: true, onClick: () => setAsking(true) }] : []}
    >
      <TextInput size="md" label={t`Nom du modèle`} description={t`le mot affiché sur la puce, par exemple : Accès et clés`} maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.currentTarget.value })} />
      <div className="grid2" style={{ marginTop: 12 }}>
        <Select size="md" label={t`Langue`} allowDeselect={false} value={v.lang} onChange={(x) => setV({ ...v, lang: (x as MessageTemplate["lang"]) ?? "fr" })} data={(["fr", "nl", "en"] as const).map((l) => ({ value: l, label: LANG[l] }))} />
        <Select size="md" label={t`Pour quels gîtes`} allowDeselect={false} value={v.pid} onChange={(x) => setV({ ...v, pid: x ?? "all" })} data={[{ value: "all", label: t`Tous mes gîtes` }, ...properties.map((p) => ({ value: String(p.id), label: p.name }))]} />
      </div>
      <Textarea ref={area} mt="md" size="md" autosize minRows={8} label={t`Texte`} maxLength={4000} value={v.body} onChange={(e) => setV({ ...v, body: e.currentTarget.value })} />
      <p className="tpl" id="vars-l">
        <Trans>Insérer à l'endroit du curseur</Trans>
      </p>
      <div className="chips" role="group" aria-labelledby="vars-l">
        {TEMPLATE_VARIABLES.map((x) => (
          <button key={x.key} type="button" className="chip" onClick={() => insert(x.key)} title={x.label}>
            {`{${x.key}}`} <small style={{ marginLeft: 4 }}>{x.label}</small>
          </button>
        ))}
      </div>
      <p className="tpl">
        <Trans>Ce que le client lira (exemple)</Trans>
      </p>
      <div className="bub out" style={{ whiteSpace: "pre-wrap" }}>
        {fillTemplate(v.body, SAMPLE)}
      </div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <NumberInput size="md" label={t`Rang dans la liste`} description={t`le plus petit en premier`} min={0} value={v.sort} onChange={(x) => setV({ ...v, sort: x })} />
      </div>
      <Switch mt="lg" size="md" label={t`Proposé quand on répond`} checked={v.active} onChange={(e) => setV({ ...v, active: e.currentTarget.checked })} />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={asking}
        title={t`Supprimer ${template?.name ?? ""} ?`}
        text={t`Les messages déjà envoyés ne changent pas. Pour le garder sans le proposer, décochez plutôt « Proposé quand on répond ».`}
        yes={t`Supprimer le modèle`}
        danger
        busy={del.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          const ok = await del.run(() => api(`/message-templates/${template!.id}`, { method: "DELETE" }), t`C'est fait. Modèle supprimé.`);
          setAsking(false);
          if (ok) onClose();
        }}
      />
    </SidePanel>
  );
}
