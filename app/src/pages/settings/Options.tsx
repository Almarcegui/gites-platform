// Options payantes (sauna, bain chaud, linge…) : une ligne par option, sa
// fiche en panneau latéral.
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Select, Switch, TextInput } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api } from "../../api/client";
import type { OptionRow, PricingMode } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { eur } from "../../lib/money";
import { Confirm, Empty, Loading, Page, parseEuros, Section, SidePanel, useWorkingProperty } from "../../ui/kit";

function useModeName() {
  const { t } = useLingui();
  return (m: PricingMode) => ({ per_stay: t`par séjour`, per_night: t`par nuit`, per_person: t`par personne`, per_person_night: t`par personne et par nuit`, per_unit_qty: t`à la pièce` })[m];
}

export function OptionsPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const q = useQuery({ queryKey: ["options", pid], queryFn: () => api<{ options: OptionRow[] }>("/options", { query: { property: pid } }).then((r) => r.options), enabled: pid != null });
  const [open, setOpen] = useState<OptionRow | "new" | null>(null);
  const mode = useModeName();
  return (
    <Page title={t`Options payantes`} back tools={picker} lead={t`Ce que le client peut ajouter à son séjour. La taxe de séjour n'est pas une option : elle se règle dans « Le domaine et les biens » et s'ajoute toute seule.`}>
      {q.error ? <ErrorLine text={t`Les options n'ont pas pu être lues.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <Section
          title={t`Options`}
          tools={
            <button type="button" className="btn pri" onClick={() => setOpen("new")}>
              <IconPlus size={20} />
              <Trans>Nouvelle option</Trans>
            </button>
          }
        >
          {q.data.length === 0 ? (
            <Empty title={t`Aucune option`} />
          ) : (
            <div className="panel">
              {q.data.map((o) => (
                <button key={o.id} type="button" className={`list-row two${o.active ? "" : " off"}`} onClick={() => setOpen(o)}>
                  <span>
                    <b>{o.name}</b>
                    <small>{[mode(o.pricingMode), o.maxQty ? t`${o.maxQty} au plus` : "", o.active ? "" : t`en pause`].filter(Boolean).join(", ")}</small>
                  </span>
                  <b className="num">{eur(o.priceCents)}</b>
                </button>
              ))}
            </div>
          )}
        </Section>
      ) : null}
      {open && pid ? <OptionPanel propertyId={pid} option={open === "new" ? null : open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function OptionPanel({ propertyId, option, onClose }: { propertyId: number; option: OptionRow | null; onClose: () => void }) {
  const { t } = useLingui();
  const modeName = useModeName();
  const init = useMemo(
    () => ({
      name: option?.name ?? "",
      mode: option?.pricingMode ?? ("per_stay" as PricingMode),
      price: (option ? option.priceCents / 100 : "") as number | string,
      unit: option?.unitLabel ?? "",
      max: (option?.maxQty ?? "") as number | string,
      sort: (option?.sortOrder ?? 0) as number | string,
      active: option?.active ?? true,
    }),
    [option],
  );
  const [v, setV] = useState(init);
  const [asking, setAsking] = useState(false);
  const a = useAction();
  const del = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(init);
  const cents = parseEuros(v.price);
  const valid = v.name.trim().length >= 2 && cents != null && cents >= 0;
  const body = { name: v.name.trim(), pricingMode: v.mode, priceCents: cents, unitLabel: v.unit, maxQty: v.max === "" ? null : Number(v.max), sortOrder: Number(v.sort) || 0, active: v.active };
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Option`}
      top={t`Option payante`}
      title={v.name.trim() || t`Nouvelle option`}
      dirty={dirty}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!valid || (!dirty && !!option) || a.state.status === "busy"}
          onClick={async () => {
            const ok = await a.run(() => (option ? api(`/options/${option.id}`, { method: "PATCH", body }) : api("/options", { method: "POST", query: { property: propertyId }, body })), option ? t`C'est fait. Option enregistrée.` : t`C'est fait. Option créée.`);
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : option ? t`Enregistrer` : t`Créer`}
        </button>
      }
      more={option ? [{ label: t`Supprimer l'option`, danger: true, onClick: () => setAsking(true) }] : []}
    >
      <TextInput size="md" label={t`Nom`} placeholder={t`Par exemple : Panier petit-déjeuner`} value={v.name} onChange={(e) => setV({ ...v, name: e.currentTarget.value })} />
      <div className="grid2" style={{ marginTop: 12 }}>
        <NumberInput size="md" label={t`Prix (€)`} min={0} decimalScale={2} decimalSeparator="," value={v.price} onChange={(x) => setV({ ...v, price: x })} />
        <Select
          size="md"
          label={t`Compté`}
          allowDeselect={false}
          value={v.mode}
          onChange={(m) => setV({ ...v, mode: (m as PricingMode) ?? "per_stay" })}
          data={(["per_stay", "per_night", "per_person", "per_person_night", "per_unit_qty"] as PricingMode[]).map((m) => ({ value: m, label: modeName(m) }))}
        />
        <TextInput size="md" label={t`Mot pour l'unité (facultatif)`} description={t`par exemple : panier, séance`} value={v.unit} onChange={(e) => setV({ ...v, unit: e.currentTarget.value })} />
        <NumberInput size="md" label={t`Quantité au plus`} description={t`vide = sans limite`} min={1} value={v.max} onChange={(x) => setV({ ...v, max: x })} />
        <NumberInput size="md" label={t`Rang dans la liste`} description={t`1 = en premier sur le site`} min={0} value={v.sort} onChange={(x) => setV({ ...v, sort: x })} />
      </div>
      <Switch mt="lg" size="md" label={t`Proposée aux clients`} checked={v.active} onChange={(e) => setV({ ...v, active: e.currentTarget.checked })} />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={asking}
        title={t`Supprimer ${option?.name ?? ""} ?`}
        text={t`Les réservations qui l'ont déjà gardent leur prix. Pour l'arrêter sans la perdre, décochez plutôt « Proposée aux clients ».`}
        yes={t`Supprimer l'option`}
        danger
        busy={del.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          const ok = await del.run(() => api(`/options/${option!.id}`, { method: "DELETE" }), t`C'est fait. Option supprimée.`);
          setAsking(false);
          if (ok) onClose();
        }}
      />
    </SidePanel>
  );
}
