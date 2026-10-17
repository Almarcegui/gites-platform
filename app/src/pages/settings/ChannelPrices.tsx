// Promotions Airbnb et prix par plateforme (lot 3), depuis Réglages › Plateformes.
//
// Deux réglages, un écran :
//  - prix par plateforme : Beds24 calcule le prix de chaque plateforme à partir
//    du prix de votre site (Booking = prix du site × 1,18…), avec les
//    majorations déjà réglées sur l'écran Plateformes ;
//  - promotions Airbnb : remises long séjour, réservation tôt, dernière minute,
//    non remboursable, avec un aperçu chiffré avant d'envoyer.
// Rien ne part chez Beds24 sans le bouton « Envoyer », et seulement si le
// serveur autorise les écritures (BEDS24_WRITE_ENABLED) : sinon l'écran le dit.
import { useLingui } from "@lingui/react/macro";
import { NumberInput } from "@mantine/core";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import type { AirbnbPreview, AirbnbPromotions, AirbnbPromotionsState, Beds24WriteState, PriceLinkingState } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { eur } from "../../lib/money";
import { Confirm, Loading, Page, SaveBar, Section, sqlWhen, useWorkingProperty } from "../../ui/kit";
import { Choix } from "../../ui/Choix";

const pctTxt = (n: number) => String(n).replace(".", ",");
const mult = (n: number) => String(n).replace(".", ",");

/** Pourquoi rien ne peut partir chez Beds24, en clair (traduit ici, pas par le serveur). */
function useClosedReason() {
  const { t } = useLingui();
  return (b: Beds24WriteState & { linked?: boolean | number }) =>
    !b.configured
      ? t`La liaison avec Beds24 n'est pas en place : rétablissez-la d'abord sur l'écran Plateformes.`
      : !b.writesAllowed
        ? t`Ce serveur n'envoie rien à Beds24 (écritures fermées). Vos réglages sont gardés ici ; ils partiront quand les écritures seront ouvertes.`
        : b.linked === false || b.linked === 0
          ? t`Aucune annonce n'est reliée à Beds24 pour l'instant.`
          : null;
}

export function ChannelPricesPage() {
  const { t } = useLingui();
  const [dirty, setDirty] = useState(false);
  const { property, picker } = useWorkingProperty(dirty);
  const pid = property?.id;
  return (
    <Page title={t`Promotions Airbnb et prix par plateforme`} back tools={picker} lead={t`Ce que voient les voyageurs sur Airbnb et Booking. Le prix de votre site ne change jamais ici.`}>
      <LinkingSection />
      {pid ? <PromotionsSection key={pid} propertyId={pid} onDirty={setDirty} /> : <Loading />}
    </Page>
  );
}

function LinkingSection() {
  const { t } = useLingui();
  const closed = useClosedReason();
  const q = useQuery({ queryKey: ["price-linking"], queryFn: () => api<PriceLinkingState>("/channels/price-linking") });
  const [asking, setAsking] = useState<boolean | null>(null);
  const a = useAction();
  const s = q.data;
  if (q.error) return <ErrorLine text={t`Les prix par plateforme n'ont pas pu être lus.`} />;
  if (!s) return <Loading />;
  const why = closed(s.beds24);
  return (
    <Section
      title={t`Prix par plateforme`}
      hint={t`Beds24 calcule le prix de chaque plateforme à partir du prix de votre site. Les pourcentages se règlent sur l'écran Plateformes, une seule fois pour tout.`}
      tools={
        <Link to="/reglages/plateformes" className="btn ghost">
          {t`Changer les pourcentages`}
        </Link>
      }
    >
      <p className="lead">
        {s.enabled
          ? t`En place : chaque plateforme a son propre prix.`
          : s.pushPct
            ? t`Aujourd'hui, toutes les plateformes reçoivent le même prix : celui de votre site + ${pctTxt(s.pushPct)} %.`
            : t`Aujourd'hui, toutes les plateformes reçoivent le prix de votre site.`}
      </p>
      <table className="tbl">
        <thead>
          <tr>
            <th>{t`Plateforme`}</th>
            <th>{t`Calcul`}</th>
            <th>{t`Une nuit à ${eur(s.exampleDirectCents)} sur votre site`}</th>
          </tr>
        </thead>
        <tbody>
          {s.lines.map((l) => (
            <tr key={l.channel}>
              <td>{l.label}</td>
              <td>{t`prix du site × ${mult(l.multiplier)} (+ ${pctTxt(l.markupPct)} %)`}</td>
              <td>
                <b>{eur(l.exampleCents)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.unlinked.length ? <p className="muted">{t`Sans équivalent chez Beds24, non envoyé : ${s.unlinked.join(", ")}.`}</p> : null}
      {s.enabled ? (
        s.upToDate ? (
          <p className="ok-line">
            <IconCheck size={20} />
            {t`Beds24 a reçu ces pourcentages${s.sentAt ? t` (le ${sqlWhen(s.sentAt)})` : ""}.`}
          </p>
        ) : (
          <p className="warn-line">
            <IconAlertTriangle size={20} />
            {t`Un pourcentage a changé depuis le dernier envoi : renvoyez-les.`}
          </p>
        )
      ) : null}
      {why ? <p className="note">{why}</p> : null}
      <div className="acts">
        {s.enabled ? (
          <>
            {!s.upToDate ? (
              <button type="button" className="btn pri" disabled={!!why || a.state.status === "busy"} onClick={() => setAsking(true)}>
                {t`Renvoyer à Beds24`}
              </button>
            ) : null}
            <button type="button" className="btn ghost" disabled={!!why || a.state.status === "busy"} onClick={() => setAsking(false)}>
              {t`Revenir au même prix partout`}
            </button>
          </>
        ) : (
          <button type="button" className="btn pri" disabled={!!why || a.state.status === "busy"} onClick={() => setAsking(true)}>
            {t`Donner à chaque plateforme son prix`}
          </button>
        )}
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={asking != null}
        title={asking ? t`Envoyer les prix par plateforme ?` : t`Revenir au même prix partout ?`}
        text={
          asking
            ? t`Beds24 calculera le prix de chaque plateforme avec ces pourcentages. Les calendriers repartent tout de suite, au prix de votre site ; c'est Beds24 qui ajoute le pourcentage.`
            : t`Toutes les plateformes recevront de nouveau le même prix. Les calendriers repartent tout de suite.`
        }
        yes={asking ? t`Envoyer` : t`Revenir au même prix`}
        busy={a.state.status === "busy"}
        onNo={() => setAsking(null)}
        onYes={async () => {
          const on = asking === true;
          await a.run(() => api("/channels/price-linking", { method: "POST", body: { enabled: on } }), on ? t`C'est fait. Chaque plateforme a son prix.` : t`C'est fait. Même prix partout.`);
          setAsking(null);
        }}
      />
    </Section>
  );
}

const FIELDS = ["weeklyPct", "biweeklyPct", "monthlyPct", "earlyBirdPct", "lastMinutePct", "nonRefundablePct"] as const;

function PromotionsSection({ propertyId, onDirty }: { propertyId: number; onDirty: (d: boolean) => void }) {
  const { t } = useLingui();
  const closed = useClosedReason();
  const q = useQuery({ queryKey: ["airbnb-promotions", propertyId], queryFn: () => api<AirbnbPromotionsState>("/channels/airbnb-promotions", { query: { property: propertyId } }) });
  const init = q.data?.promotions;
  const [v, setV] = useState<AirbnbPromotions | null>(null);
  useEffect(() => {
    if (init && !v) setV(init);
  }, [init, v]);
  const dirty = !!(v && init && JSON.stringify(v) !== JSON.stringify(init));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const [stay, setStay] = useState<number | string>(1400);
  const [nights, setNights] = useState<number | string>(7);
  const save = useAction();
  const send = useAction();
  const [asking, setAsking] = useState(false);
  const previewBody = useMemo(() => (v ? { promotions: v, stayCents: Math.round(Number(stay) * 100), nights: Math.floor(Number(nights)) } : null), [v, stay, nights]);
  const pv = useQuery({
    queryKey: ["airbnb-preview", previewBody],
    queryFn: () => api<AirbnbPreview>("/channels/airbnb-promotions/preview", { method: "POST", body: previewBody }),
    enabled: !!previewBody && Number(stay) >= 1 && Number(nights) >= 1,
    placeholderData: (prev) => prev,
  });
  if (q.error) return <ErrorLine text={t`Les promotions Airbnb n'ont pas pu être lues.`} />;
  if (!q.data || !v) return <Loading />;
  const s = q.data;
  const why = closed(s.beds24);
  const set = (k: keyof AirbnbPromotions, x: number | string | null) => setV({ ...v, [k]: x === "" || x == null ? (k === "earlyBirdDays" || k === "lastMinuteDays" ? null : 0) : Number(x) });
  const p = pv.data ?? s.preview;
  const pctInput = (k: (typeof FIELDS)[number], label: string, max: number) => (
    <NumberInput size="md" w={150} min={0} max={max} step={1} allowDecimal={false} suffix=" %" label={label} value={v[k]} onChange={(x) => set(k, x)} />
  );
  return (
    <Section title={t`Promotions Airbnb`} hint={t`Airbnb affiche ces remises aux voyageurs. Elles passent par Beds24 ; Booking.com et Vrbo se règlent encore dans leur propre espace.`}>
      <div className="form-grid">
        <fieldset className="fs">
          <legend>{t`Séjours longs`}</legend>
          <div className="row-in">
            {pctInput("weeklyPct", t`7 nuits et plus`, 90)}
            {pctInput("biweeklyPct", t`14 nuits et plus`, 90)}
            {pctInput("monthlyPct", t`28 nuits et plus`, 90)}
          </div>
        </fieldset>
        <fieldset className="fs">
          <legend>{t`Réservation tôt`}</legend>
          <div className="row-in">
            <Choix
              size="md"
              w={220}
              label={t`Au moins … avant l'arrivée`}
              placeholder={t`pas de remise`}
              clearable
              data={s.earlyBirdDays.map((d) => ({ value: String(d), label: t`${d} jours` }))}
              value={v.earlyBirdDays == null ? null : String(v.earlyBirdDays)}
              onChange={(x) => set("earlyBirdDays", x == null ? null : Number(x))}
            />
            {pctInput("earlyBirdPct", t`Remise`, 50)}
          </div>
        </fieldset>
        <fieldset className="fs">
          <legend>{t`Dernière minute`}</legend>
          <div className="row-in">
            <NumberInput size="md" w={220} min={1} max={28} allowDecimal={false} label={t`Jours avant l'arrivée (1 à 28)`} placeholder={t`pas de remise`} value={v.lastMinuteDays ?? ""} onChange={(x) => set("lastMinuteDays", x === "" ? null : x)} />
            {pctInput("lastMinutePct", t`Remise`, 50)}
          </div>
        </fieldset>
        <fieldset className="fs">
          <legend>{t`Non remboursable`}</legend>
          <div className="row-in">{pctInput("nonRefundablePct", t`Remise pour un tarif sans remboursement`, 50)}</div>
        </fieldset>
      </div>

      <section className="preview" aria-label={t`Aperçu`}>
        <h3 className="sub">{t`Aperçu`}</h3>
        <div className="row-in">
          <NumberInput size="md" w={170} min={1} label={t`Séjour sur votre site`} suffix=" €" thousandSeparator=" " decimalSeparator="," value={stay} onChange={setStay} />
          <NumberInput size="md" w={120} min={1} max={365} allowDecimal={false} label={t`Nuits`} value={nights} onChange={setNights} />
        </div>
        {pv.error ? <ErrorLine text={t`Aperçu impossible avec ces valeurs.`} /> : null}
        <p className="lead" data-testid="apercu">
          {t`Un séjour de ${p.nights} nuits à ${eur(p.stayCents)} part à ${eur(p.withLengthCents)} sur Airbnb`}
          {p.lengthPct ? t` (${eur(p.airbnbCents)} avec + ${pctTxt(p.markupPct)} %, puis − ${p.lengthPct} % pour ${p.nights} nuits).` : p.markupPct ? t` (+ ${pctTxt(p.markupPct)} %, sans remise de durée).` : "."}
        </p>
        <ul className="plain-list">
          {p.nonRefundableCents != null ? <li>{t`Non remboursable : ${eur(p.nonRefundableCents)}`}</li> : null}
          {p.earlyBirdCents != null ? <li>{t`Réservé tôt : ${eur(p.earlyBirdCents)}`}</li> : null}
          {p.lastMinuteCents != null ? <li>{t`Dernière minute : ${eur(p.lastMinuteCents)}`}</li> : null}
        </ul>
        <p className="muted">{t`Chaque ligne compte une seule remise en plus de la durée. Airbnb décide lui-même si elles se cumulent.`}</p>
      </section>

      <p className="muted">
        {s.lastSent ? (s.sentSame ? t`Airbnb a reçu ces promotions le ${sqlWhen(s.lastSent.at)}.` : t`Enregistré ici, pas encore envoyé à Airbnb (dernier envoi : ${sqlWhen(s.lastSent.at)}).`) : t`Jamais envoyé à Airbnb.`}
      </p>
      {why ? <p className="note">{why}</p> : null}
      <div className="acts">
        <button type="button" className="btn" disabled={dirty || !!why || s.sentSame || send.state.status === "busy"} title={dirty ? t`Enregistrez d'abord` : undefined} onClick={() => setAsking(true)}>
          {t`Envoyer à Airbnb`}
        </button>
      </div>
      {send.state.status === "error" ? <ErrorLine text={send.state.text} /> : null}
      <SaveBar
        dirty={dirty}
        busy={save.state.status === "busy"}
        error={save.state.status === "error" ? save.state.text : null}
        label={t`Enregistrer les promotions`}
        onReset={() => setV(init ?? null)}
        onSave={async () => {
          const ok = await save.run(() => api<AirbnbPromotionsState>("/channels/airbnb-promotions", { method: "PUT", body: { propertyId, promotions: v } }), t`C'est fait. Promotions enregistrées, pas encore envoyées.`);
          if (ok) setV(null);
        }}
      />
      <Confirm
        open={asking}
        title={t`Envoyer ces promotions à Airbnb ?`}
        text={t`Elles s'appliquent à toutes les annonces Airbnb de ce domaine, par Beds24, dès réception.`}
        yes={t`Envoyer`}
        busy={send.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          await send.run(() => api("/channels/airbnb-promotions/send", { method: "POST", body: { propertyId } }), t`C'est fait. Airbnb a reçu les promotions.`);
          setAsking(false);
        }}
      />
    </Section>
  );
}
