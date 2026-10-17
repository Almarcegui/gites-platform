// Modèles de réponse (plan v4, fonction 2) : les textes proposés dans Messages
// et dans la fiche réservation. Une ligne par modèle, sa fiche en panneau.
import { t } from "@lingui/core/macro";
import { hourLabel, longDate } from "../../lib/dates";
import { eur } from "../../lib/money";
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Select, Switch, Textarea, TextInput } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { api } from "../../api/client";
import { useProperties } from "../../api/hooks";
import type { MessageTemplate } from "../../api/types";
import { ErrorLine, useAction } from "../../lib/action";
import { fillTemplate, templateVariables } from "../../lib/templates";
import { Confirm, Empty, Loading, Page, Section, SidePanel, useWorkingProperty } from "../../ui/kit";

const langLabel = (l: MessageTemplate["lang"]): string => (l === "nl" ? t`néerlandais` : l === "en" ? t`anglais` : t`français`);

/** Exemple de remplissage montré sous le texte : le résultat se lit avant l'envoi. */
const sample = () => ({ firstName: "Claire", unitName: "La Scierie", arrival: longDate("2026-10-17"), checkinTime: hourLabel("16:00"), checkoutTime: hourLabel("10:00"), balance: eur(45000), signature: "Les Gîtes du Pré Moré" });

/** Variables des intros de mails : celles des modèles, plus {reference} et
 *  {lien} (lien de reprise, relance seulement). Vide = texte d'origine. */
const introVariables = (): { key: string; label: string }[] => [
  ...templateVariables(),
  { key: "reference", label: t`référence de la réservation` },
];

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
        <>
        <MailIntroSection
          mail="confirmation"
          title={t`Mail de confirmation`}
          hint={t`L'intro du mail envoyé à la confirmation d'une réservation, en français et en néerlandais. Le reste du mail (séjour, prix, bouton, PDF joint) est automatique. Laissez vide pour le texte d'origine.`}
        />
        <MailIntroSection
          mail="annulation"
          title={t`Mail d'annulation`}
          hint={t`L'annonce de l'annulation, en français et en néerlandais. Les lignes légales (article des conditions, remboursement, indemnité) restent automatiques : elles portent les montants exacts. Laissez vide pour le texte d'origine.`}
        />
        <MailIntroSection
          mail="relance"
          title={t`Relance d'une réservation abandonnée`}
          hint={t`Le texte du message envoyé une seule fois à un visiteur qui n'a pas achevé sa réservation. Le lien de reprise et la mention « un seul message » restent automatiques. Laissez vide pour le texte d'origine.`}
        />
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
                    <small>{[langLabel(m.lang), where(m.propertyId), m.active ? "" : t`en pause`].filter(Boolean).join(", ")}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>
        </>
      ) : null}
      {open ? <TemplatePanel template={open === "new" ? null : open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

/** Intro d'un mail automatique, par langue : vide = texte d'origine.
 *  Sauvegardée dans les réglages du domaine (confirmation_intro_fr/_nl,
 *  cancellation_intro_fr/_nl, abandon_intro_fr), appliquée à l'envoi. */
function MailIntroSection({ mail, title, hint }: { mail: "confirmation" | "annulation" | "relance"; title: string; hint: string }) {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const propertyId = property?.id;
  const keys =
    mail === "confirmation"
      ? { fr: "confirmation_intro_fr", nl: "confirmation_intro_nl" }
      : mail === "annulation"
        ? { fr: "cancellation_intro_fr", nl: "cancellation_intro_nl" }
        : { fr: "abandon_intro_fr", nl: null };
  const sq = useQuery({
    queryKey: ["settings", propertyId],
    enabled: propertyId != null,
    queryFn: () => api<{ settings: Record<string, string> }>("/settings", { query: { property: propertyId } }),
  });
  const s = sq.data?.settings ?? {};
  const base = { fr: s[keys.fr] ?? "", nl: keys.nl ? (s[keys.nl] ?? "") : "" };
  const [v, setV] = useState<{ fr: string; nl: string } | null>(null);
  const form = v ?? base;
  const a = useAction();
  const dirty = propertyId != null && (form.fr !== base.fr || form.nl !== base.nl);
  const area = useRef<HTMLTextAreaElement>(null);
  const insert = (key: string) => {
    const el = area.current;
    const token = `{${key}}`;
    if (!el) return;
    const start = el.selectionStart ?? form.fr.length;
    const end = el.selectionEnd ?? start;
    setV({ ...form, fr: form.fr.slice(0, start) + token + form.fr.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <Section title={title} hint={hint} tools={picker}>
      {sq.error ? <ErrorLine text={t`Les réglages n'ont pas pu être lus.`} /> : null}
      {propertyId == null ? (
        <Loading />
      ) : (
        <>
          <div className={keys.nl ? "grid2" : undefined}>
            <Textarea size="md" autosize minRows={4} label={t`Intro en français`} maxLength={2000} value={form.fr} onChange={(e) => setV({ ...form, fr: e.currentTarget.value })} />
            {keys.nl ? (
              <Textarea ref={area} size="md" autosize minRows={4} label={t`Intro en néerlandais`} maxLength={2000} value={form.nl} onChange={(e) => setV({ ...form, nl: e.currentTarget.value })} />
            ) : null}
          </div>
          <p className="tpl" id={`intro-${mail}-vars-l`}>
            <Trans>Insérer à l'endroit du curseur</Trans>
          </p>
          <div className="chips" role="group" aria-labelledby={`intro-${mail}-vars-l`}>
            {introVariables().map((x) => (
              <button key={x.key} type="button" className="chip" onClick={() => insert(x.key)} title={x.label}>
                {`{${x.key}}`} <small style={{ marginLeft: 4 }}>{x.label}</small>
              </button>
            ))}
          </div>
          <p className="tpl">
            <Trans>Ce que le client lira (exemple, en français)</Trans>
          </p>
          <div className="bub out" style={{ whiteSpace: "pre-wrap" }}>
            {fillTemplate(form.fr, sample())}
          </div>
          <button
            type="button"
            className="btn pri"
            style={{ marginTop: 12 }}
            disabled={!dirty || a.state.status === "busy"}
            onClick={() =>
              a.run(
                () =>
                  api("/settings", {
                    method: "PUT",
                    query: { property: propertyId },
                    body: { settings: { [keys.fr]: form.fr, ...(keys.nl ? { [keys.nl]: form.nl } : {}) } },
                  }),
                t`C'est fait. Intro enregistrée.`,
              )
            }
          >
            {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer l'intro`}
          </button>
          {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
        </>
      )}
    </Section>
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
        <Select size="md" label={t`Langue`} allowDeselect={false} value={v.lang} onChange={(x) => setV({ ...v, lang: (x as MessageTemplate["lang"]) ?? "fr" })} data={(["fr", "nl", "en"] as const).map((l) => ({ value: l, label: langLabel(l) }))} />
        <Select size="md" label={t`Pour quels gîtes`} allowDeselect={false} value={v.pid} onChange={(x) => setV({ ...v, pid: x ?? "all" })} data={[{ value: "all", label: t`Tous mes gîtes` }, ...properties.map((p) => ({ value: String(p.id), label: p.name }))]} />
      </div>
      <Textarea ref={area} mt="md" size="md" autosize minRows={8} label={t`Texte`} maxLength={4000} value={v.body} onChange={(e) => setV({ ...v, body: e.currentTarget.value })} />
      <p className="tpl" id="vars-l">
        <Trans>Insérer à l'endroit du curseur</Trans>
      </p>
      <div className="chips" role="group" aria-labelledby="vars-l">
        {templateVariables().map((x) => (
          <button key={x.key} type="button" className="chip" onClick={() => insert(x.key)} title={x.label}>
            {`{${x.key}}`} <small style={{ marginLeft: 4 }}>{x.label}</small>
          </button>
        ))}
      </div>
      <p className="tpl">
        <Trans>Ce que le client lira (exemple)</Trans>
      </p>
      <div className="bub out" style={{ whiteSpace: "pre-wrap" }}>
        {fillTemplate(v.body, sample())}
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
