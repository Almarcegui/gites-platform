// Remises et codes promo — l'ancien « Promotions », en phrases. Une ligne
// ouvre sa fiche en panneau latéral ; un panneau en saisie ne se ferme pas seul.
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Select, Switch, TextInput } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api } from "../../api/client";
import type { Promotion } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { longDate } from "../../lib/dates";
import { eur } from "../../lib/money";
import { Confirm, Empty, Loading, Page, parseEuros, Section, SidePanel, useWorkingProperty } from "../../ui/kit";

type Kind = Promotion["kind"];

function usePromoText() {
  const { t } = useLingui();
  const kindName = (k: Kind) => ({ code: t`Code promo`, long_stay: t`Long séjour`, early_bird: t`Réservation tôt`, last_minute: t`Dernière minute` })[k];
  const off = (p: Pick<Promotion, "discountPct" | "discountCents">) => (p.discountPct ? t`− ${p.discountPct} %` : t`− ${eur(p.discountCents ?? 0)}`);
  const when = (p: Promotion) => {
    if (p.kind === "long_stay") return t`dès ${p.threshold ?? 0} nuits`;
    if (p.kind === "early_bird") return t`réservé au moins ${p.threshold ?? 0} jours avant l'arrivée`;
    if (p.kind === "last_minute") return t`réservé ${p.threshold ?? 0} jours ou moins avant l'arrivée`;
    const parts = [];
    if (p.validFrom) parts.push(t`à partir du ${longDate(p.validFrom)}`);
    if (p.validUntil) parts.push(t`jusqu'au ${longDate(p.validUntil)}`);
    parts.push(p.maxUses ? t`utilisé ${p.uses} fois sur ${p.maxUses}` : t`utilisé ${p.uses} fois`);
    return parts.join(", ");
  };
  return { kindName, off, when };
}

export function PromotionsPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const q = useQuery({ queryKey: ["promotions", pid], queryFn: () => api<{ promotions: Promotion[] }>("/promotions", { query: { property: pid } }).then((r) => r.promotions), enabled: pid != null });
  const [open, setOpen] = useState<Promotion | Kind | null>(null);
  const txt = usePromoText();
  const autos = (q.data ?? []).filter((p) => p.kind !== "code");
  const codes = (q.data ?? []).filter((p) => p.kind === "code");
  const row = (p: Promotion) => (
    <button key={p.id} type="button" role="listitem" className={`list-row two${p.active ? "" : " off"}`} onClick={() => setOpen(p)}>
      <span>
        <b>{p.kind === "code" ? p.code : p.label || txt.kindName(p.kind)}</b>
        <small>
          {txt.kindName(p.kind)} : {txt.when(p)}
        </small>
      </span>
      <span style={{ textAlign: "right" }}>
        <b className="num">{txt.off(p)}</b>
        <small>{p.active ? t`active` : t`en pause`}</small>
      </span>
    </button>
  );
  return (
    <Page title={t`Remises et codes promo`} back tools={picker} lead={t`La meilleure remise automatique s'applique seule ; un code promo s'ajoute ensuite. Les remises portent sur les nuits, pas sur le ménage ni les options.`}>
      {q.error ? <ErrorLine text={t`Les remises n'ont pas pu être lues.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <>
          <Section
            title={t`Remises automatiques`}
            hint={t`Accordées toutes seules quand le séjour remplit la condition.`}
            tools={
              <button type="button" className="btn" onClick={() => setOpen("long_stay")}>
                <IconPlus size={20} />
                <Trans>Nouvelle remise</Trans>
              </button>
            }
          >
            {autos.length ? <div className="panel" role="list">{autos.map(row)}</div> : <Empty title={t`Aucune remise automatique`} />}
          </Section>
          <Section
            title={t`Codes promo`}
            hint={t`Le client tape le code sur votre site au moment de réserver.`}
            tools={
              <button type="button" className="btn pri" onClick={() => setOpen("code")}>
                <IconPlus size={20} />
                <Trans>Nouveau code</Trans>
              </button>
            }
          >
            {codes.length ? <div className="panel" role="list">{codes.map(row)}</div> : <Empty title={t`Aucun code promo`} />}
          </Section>
        </>
      ) : null}
      {open && pid ? <PromoPanel propertyId={pid} promo={typeof open === "string" ? null : open} kind={typeof open === "string" ? open : open.kind} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

function PromoPanel({ propertyId, promo, kind: kind0, onClose }: { propertyId: number; promo: Promotion | null; kind: Kind; onClose: () => void }) {
  const { t } = useLingui();
  const txt = usePromoText();
  const init = useMemo(
    () => ({
      kind: kind0,
      code: promo?.code ?? "",
      label: promo?.label ?? "",
      mode: promo?.discountCents && !promo.discountPct ? ("eur" as const) : ("pct" as const),
      pct: (promo?.discountPct ?? "") as number | string,
      euros: (promo?.discountCents != null ? promo.discountCents / 100 : "") as number | string,
      threshold: (promo?.threshold ?? "") as number | string,
      from: promo?.validFrom ?? "",
      until: promo?.validUntil ?? "",
      max: (promo?.maxUses ?? "") as number | string,
      active: promo?.active ?? true,
    }),
    [promo, kind0],
  );
  const [v, setV] = useState(init);
  const [asking, setAsking] = useState(false);
  const a = useAction();
  const del = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(init);
  const isCode = v.kind === "code";
  const valid = (isCode ? v.code.trim().length >= 2 : v.threshold !== "") && (v.mode === "pct" ? Number(v.pct) > 0 && Number(v.pct) <= 100 : (parseEuros(v.euros) ?? 0) > 0);
  const body = {
    kind: v.kind,
    code: isCode ? v.code.trim().toUpperCase() : undefined,
    label: v.label.trim() || undefined,
    discountPct: v.mode === "pct" ? Number(v.pct) : null,
    discountCents: v.mode === "eur" ? parseEuros(v.euros) : null,
    threshold: isCode ? null : Number(v.threshold),
    validFrom: v.from || null,
    validUntil: v.until || null,
    maxUses: v.max === "" ? null : Number(v.max),
    active: v.active,
  };
  const title = isCode ? v.code.trim().toUpperCase() || t`Nouveau code` : v.label.trim() || txt.kindName(v.kind);
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Remise`}
      top={txt.kindName(v.kind)}
      title={title}
      dirty={dirty}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!valid || (!dirty && !!promo) || a.state.status === "busy"}
          onClick={async () => {
            const ok = await a.run(
              () => (promo ? api(`/promotions/${promo.id}`, { method: "PATCH", body }) : api("/promotions", { method: "POST", query: { property: propertyId }, body })),
              promo ? t`C'est fait. Remise enregistrée.` : t`C'est fait. Remise créée.`,
            );
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : promo ? t`Enregistrer` : t`Créer`}
        </button>
      }
      more={promo ? [{ label: t`Supprimer`, danger: true, onClick: () => setAsking(true) }] : []}
    >
      {!promo && !isCode ? (
        <Select
          size="md"
          label={t`Type de remise`}
          allowDeselect={false}
          value={v.kind}
          onChange={(k) => setV({ ...v, kind: (k as Kind) ?? "long_stay" })}
          data={[
            { value: "long_stay", label: t`Long séjour (à partir d'un nombre de nuits)` },
            { value: "early_bird", label: t`Réservation tôt (longtemps avant l'arrivée)` },
            { value: "last_minute", label: t`Dernière minute (peu avant l'arrivée)` },
          ]}
        />
      ) : null}
      {isCode ? <TextInput size="md" label={t`Code`} description={t`ce que le client tape, par exemple ETE2026`} value={v.code} onChange={(e) => setV({ ...v, code: e.currentTarget.value })} /> : null}
      <TextInput mt="sm" size="md" label={t`Nom affiché au client (facultatif)`} value={v.label} onChange={(e) => setV({ ...v, label: e.currentTarget.value })} />
      {!isCode ? (
        <NumberInput
          mt="sm"
          size="md"
          min={0}
          label={v.kind === "long_stay" ? t`À partir de combien de nuits` : v.kind === "early_bird" ? t`Au moins combien de jours avant l'arrivée` : t`Au plus combien de jours avant l'arrivée`}
          value={v.threshold}
          onChange={(x) => setV({ ...v, threshold: x })}
        />
      ) : null}
      <div className="seg" role="group" aria-label={t`Remise en pourcentage ou en euros`} style={{ marginTop: 14 }}>
        <button type="button" aria-pressed={v.mode === "pct"} onClick={() => setV({ ...v, mode: "pct" })}>
          <Trans>En pourcentage</Trans>
        </button>
        <button type="button" aria-pressed={v.mode === "eur"} onClick={() => setV({ ...v, mode: "eur" })}>
          <Trans>En euros</Trans>
        </button>
      </div>
      {v.mode === "pct" ? (
        <NumberInput size="md" label={t`Remise (%)`} min={1} max={100} value={v.pct} onChange={(x) => setV({ ...v, pct: x })} />
      ) : (
        <NumberInput size="md" label={t`Remise (€)`} min={1} decimalScale={2} decimalSeparator="," value={v.euros} onChange={(x) => setV({ ...v, euros: x })} />
      )}
      {isCode ? (
        <div className="grid2" style={{ marginTop: 12 }}>
          <TextInput size="md" type="date" label={t`Valable à partir du`} value={v.from} onChange={(e) => setV({ ...v, from: e.currentTarget.value })} />
          <TextInput size="md" type="date" label={t`Valable jusqu'au`} value={v.until} onChange={(e) => setV({ ...v, until: e.currentTarget.value })} />
          <NumberInput size="md" label={t`Nombre d'utilisations au plus`} description={t`vide = sans limite`} min={1} value={v.max} onChange={(x) => setV({ ...v, max: x })} />
        </div>
      ) : null}
      <Switch mt="lg" size="md" label={t`Remise active`} checked={v.active} onChange={(e) => setV({ ...v, active: e.currentTarget.checked })} />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={asking}
        title={t`Supprimer ${title} ?`}
        text={t`Les réservations déjà faites gardent leur remise. Pour l'arrêter sans la perdre, mettez-la plutôt en pause.`}
        yes={t`Supprimer`}
        danger
        busy={del.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          const ok = await del.run(() => api(`/promotions/${promo!.id}`, { method: "DELETE" }), t`C'est fait. Remise supprimée.`);
          setAsking(false);
          if (ok) onClose();
        }}
      />
    </SidePanel>
  );
}
