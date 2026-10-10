// Le domaine et les biens : toutes les cartes de l'ancien « Paramètres » sur
// une seule page, avec un seul « Enregistrer ». Tant que quelque chose n'est
// pas enregistré, la barre du bas le dit et la page retient la navigation.
// Photos d'un bien et ajout d'un bien : en panneau et en boîte, chacun avec
// son propre bouton (ils n'attendent pas l'enregistrement de la page).
import { Trans, useLingui } from "@lingui/react/macro";
import { Checkbox, NumberInput, Select, Switch, Textarea, TextInput } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconPhoto, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { api, errorText } from "../../api/client";
import { useRefresh } from "../../api/hooks";
import type { UnitLink } from "../../api/types";
import type { FullSettings, Photo, PropertyFull, UnitFull } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { useToast } from "../../lib/toasts";
import { Box, Fold, Loading, Page, parseEuros, SaveBar, Section, SidePanel, useWorkingProperty } from "../../ui/kit";
import { useSettingsFull, useUnitsFull } from "./useAdmin";

interface UnitForm {
  name: string;
  description: string;
  capacityBase: number | string;
  capacityMax: number | string;
  cleaning: number | string;
  deposit: number | string;
  compositePricing: "own" | "sum";
  active: boolean;
  photoUrl: string;
  links: number[];
}

interface Form {
  prop: { name: string; commune: string; address: string; contactEmail: string; contactPhone: string };
  set: {
    checkin_time: string;
    checkout_time: string;
    deposit_pct: number | string;
    balance_due_days: number | string;
    hold_minutes: number | string;
    allow_deposit: boolean;
    allow_full_payment: boolean;
    tourist_tax: number | string;
    tourist_tax_include_children: boolean;
    auto_reply_enabled: boolean;
    auto_reply_text: string;
    email_forward_to: string;
    cgv_text: string;
  };
  units: Record<number, UnitForm>;
}

function partnersOf(id: number, links: UnitLink[]): number[] {
  return links.filter((l) => l.unitId === id).map((l) => l.blocksUnitId).sort((a, b) => a - b);
}

function toForm(p: PropertyFull, s: FullSettings, units: UnitFull[], links: UnitLink[]): Form {
  return {
    prop: { name: p.name, commune: p.commune ?? "", address: p.address ?? "", contactEmail: p.contactEmail ?? "", contactPhone: p.contactPhone ?? "" },
    set: {
      checkin_time: s.checkinTime,
      checkout_time: s.checkoutTime,
      deposit_pct: s.depositPct,
      balance_due_days: s.balanceDueDays,
      hold_minutes: s.holdMinutes,
      allow_deposit: s.allowDeposit,
      allow_full_payment: s.allowFullPayment,
      tourist_tax: s.touristTaxCentsPerPersonNight / 100,
      tourist_tax_include_children: s.touristTaxIncludeChildren,
      auto_reply_enabled: s.autoReplyEnabled,
      auto_reply_text: s.autoReplyText,
      email_forward_to: s.emailForwardTo,
      cgv_text: s.cgvText,
    },
    units: Object.fromEntries(
      units.map((u) => [
        u.id,
        {
          name: u.name,
          description: u.description ?? "",
          capacityBase: u.capacityBase,
          capacityMax: u.capacityMax,
          cleaning: u.cleaningFeeCents / 100,
          deposit: u.depositPct ?? "",
          compositePricing: u.compositePricing,
          active: u.active,
          photoUrl: u.photoUrl ?? "",
          links: partnersOf(u.id, links),
        },
      ]),
    ),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function DomainPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const sq = useSettingsFull(pid);
  const uq = useUnitsFull(pid);
  const init = useMemo(() => (sq.data && uq.data ? toForm(sq.data.property, sq.data.settings, sq.data.units, uq.data.links) : null), [sq.data, uq.data]);
  return (
    <Page title={t`Le domaine et les biens`} back tools={picker} width={900}>
      {sq.error || uq.error ? <ErrorLine text={t`Les réglages n'ont pas pu être lus.`} /> : null}
      {!init ? <Loading /> : <DomainForm key={pid} propertyId={pid!} init={init} units={sq.data!.units} />}
    </Page>
  );
}

function DomainForm({ propertyId, init, units }: { propertyId: number; init: Form; units: UnitFull[] }) {
  const { t } = useLingui();
  const toast = useToast();
  const refresh = useRefresh();
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<UnitFull | null>(null);
  const [adding, setAdding] = useState(false);
  // Les données relues après un enregistrement deviennent la nouvelle base.
  const [base, setBase] = useState(init);
  const dirty = !same(f, base);
  useEffect(() => {
    if (!same(init, base) && !dirty) {
      setBase(init);
      setF(init);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init]);
  const setS = <K extends keyof Form["set"]>(k: K, v: Form["set"][K]) => setF({ ...f, set: { ...f.set, [k]: v } });
  const setP = (k: keyof Form["prop"], v: string) => setF({ ...f, prop: { ...f.prop, [k]: v } });
  const setU = (id: number, patch: Partial<UnitForm>) => setF({ ...f, units: { ...f.units, [id]: { ...f.units[id]!, ...patch } } });

  async function save() {
    setBusy(true);
    setError(null);
    const done: string[] = [];
    try {
      if (!same(f.prop, base.prop)) {
        await api(`/properties/${propertyId}`, { method: "PATCH", body: f.prop });
        done.push(t`coordonnées`);
      }
      const settings: Record<string, string | number | boolean> = {};
      for (const k of Object.keys(f.set) as (keyof Form["set"])[]) {
        if (same(f.set[k], base.set[k])) continue;
        if (k === "tourist_tax") settings.tourist_tax_cents_per_person_night = parseEuros(f.set.tourist_tax) ?? 0;
        else settings[k] = f.set[k] as string | number | boolean;
      }
      if (Object.keys(settings).length) {
        await api("/settings", { method: "PUT", query: { property: propertyId }, body: { settings } });
        done.push(t`réglages`);
      }
      for (const u of units) {
        const a = f.units[u.id]!;
        const b = base.units[u.id]!;
        const { links: la, ...ra } = a;
        const { links: lb, ...rb } = b;
        if (!same(ra, rb)) {
          await api(`/units/${u.id}`, {
            method: "PATCH",
            body: {
              name: a.name.trim(),
              description: a.description,
              capacityBase: Number(a.capacityBase),
              capacityMax: Number(a.capacityMax),
              cleaningFeeCents: parseEuros(a.cleaning) ?? 0,
              depositPct: a.deposit === "" ? null : Number(a.deposit),
              active: a.active,
              photoUrl: a.photoUrl.trim(),
              ...(u.isComposite ? { compositePricing: a.compositePricing } : {}),
            },
          });
          done.push(a.name.trim());
        }
        if (!same(la, lb)) {
          await api(`/units/${u.id}/links`, { method: "PUT", body: { partnerIds: la } });
          done.push(t`liaisons de ${a.name.trim()}`);
        }
      }
      setBase(f);
      toast(t`C'est fait. Enregistré : ${done.join(", ")}.`);
      await refresh();
    } catch (e) {
      setError(done.length ? t`Enregistré : ${done.join(", ")}. Puis refusé : ${errorText(e)} Le reste n'est pas enregistré.` : errorText(e));
      if (done.length) await refresh();
    } finally {
      setBusy(false);
    }
  }

  const hours = Math.round((Number(f.set.hold_minutes) || 0) / 60);
  return (
    <>
      <Section title={t`Le domaine`} hint={t`Ce qui s'affiche sur le site, les mails et les conditions.`}>
        <div className="grid2">
          <TextInput size="md" label={t`Nom`} value={f.prop.name} onChange={(e) => setP("name", e.currentTarget.value)} />
          <TextInput size="md" label={t`Commune`} description={t`sert aussi pour la taxe de séjour`} value={f.prop.commune} onChange={(e) => setP("commune", e.currentTarget.value)} />
          <TextInput size="md" label={t`Adresse`} value={f.prop.address} onChange={(e) => setP("address", e.currentTarget.value)} />
          <TextInput size="md" type="email" label={t`Mail de contact`} value={f.prop.contactEmail} onChange={(e) => setP("contactEmail", e.currentTarget.value)} />
          <TextInput size="md" type="tel" label={t`Téléphone`} value={f.prop.contactPhone} onChange={(e) => setP("contactPhone", e.currentTarget.value)} />
        </div>
      </Section>

      <Section title={t`Arrivée et départ`}>
        <div className="grid2">
          <TextInput size="md" type="time" label={t`Arrivée à partir de`} value={f.set.checkin_time} onChange={(e) => setS("checkin_time", e.currentTarget.value)} />
          <TextInput size="md" type="time" label={t`Départ au plus tard à`} value={f.set.checkout_time} onChange={(e) => setS("checkout_time", e.currentTarget.value)} />
        </div>
        {f.set.checkin_time === f.set.checkout_time ? <p className="warn">{t`Arrivée et départ sont à la même heure : le ménage n'a pas de temps entre deux séjours. Vérifiez ces heures.`}</p> : null}
      </Section>

      <Section title={t`Paiement`} hint={t`Comment les clients paient sur votre site.`}>
        <div className="grid2">
          <NumberInput size="md" label={t`Arrhes à la réservation (%)`} description={t`chaque bien peut avoir le sien, plus bas`} min={0} max={100} value={f.set.deposit_pct} onChange={(v) => setS("deposit_pct", v)} />
          <NumberInput size="md" label={t`Solde à payer, jours avant l'arrivée`} min={0} max={365} value={f.set.balance_due_days} onChange={(v) => setS("balance_due_days", v)} />
          <NumberInput size="md" label={t`Une option garde les dates pendant (minutes)`} description={hours >= 1 ? t`soit environ ${hours} h` : t`moins d'une heure`} min={5} value={f.set.hold_minutes} onChange={(v) => setS("hold_minutes", v)} />
        </div>
        <Switch mt="md" size="md" label={t`Le client peut payer des arrhes`} checked={f.set.allow_deposit} onChange={(e) => setS("allow_deposit", e.currentTarget.checked)} />
        <Switch mt="sm" size="md" label={t`Le client peut payer tout le séjour d'un coup`} checked={f.set.allow_full_payment} onChange={(e) => setS("allow_full_payment", e.currentTarget.checked)} />
      </Section>

      <Section title={t`Taxe de séjour`}>
        <div className="grid2">
          <NumberInput size="md" label={t`Par personne et par nuit (€)`} min={0} decimalScale={2} decimalSeparator="," value={f.set.tourist_tax} onChange={(v) => setS("tourist_tax", v)} />
        </div>
        <Switch mt="md" size="md" label={t`Les enfants paient aussi la taxe`} checked={f.set.tourist_tax_include_children} onChange={(e) => setS("tourist_tax_include_children", e.currentTarget.checked)} />
      </Section>

      <Section title={t`Mails reçus`}>
        <Switch size="md" label={t`Répondre tout de suite par un accusé de réception`} checked={f.set.auto_reply_enabled} onChange={(e) => setS("auto_reply_enabled", e.currentTarget.checked)} />
        <Textarea mt="sm" size="md" autosize minRows={4} label={t`Texte de l'accusé de réception`} description={t`${"{nom}"} et ${"{reference}"} sont remplacés par le nom du client et la référence de sa réservation`} value={f.set.auto_reply_text} onChange={(e) => setS("auto_reply_text", e.currentTarget.value)} />
        <TextInput mt="sm" size="md" type="email" label={t`Faire suivre les mails reçus à`} placeholder="vous@exemple.be" value={f.set.email_forward_to} onChange={(e) => setS("email_forward_to", e.currentTarget.value)} />
      </Section>

      <Section title={t`Conditions de location`} hint={t`Jointes à chaque confirmation. Une ligne « Article 1 » seule s'affiche en gras sur le site.`}>
        <Fold title={t`Texte des conditions`} count={t`${f.set.cgv_text.length} caractères`}>
          <Textarea size="md" autosize minRows={8} maxRows={30} aria-label={t`Texte des conditions`} value={f.set.cgv_text} onChange={(e) => setS("cgv_text", e.currentTarget.value)} />
        </Fold>
      </Section>

      <Section
        title={t`Les biens`}
        tools={
          <button type="button" className="btn" onClick={() => setAdding(true)} disabled={dirty} title={dirty ? t`Enregistrez d'abord la page` : undefined}>
            <IconPlus size={20} />
            <Trans>Ajouter un bien</Trans>
          </button>
        }
      >
        {units.map((u) => {
          const x = f.units[u.id]!;
          const others = units.filter((o) => o.id !== u.id);
          return (
            <Fold key={u.id} title={x.name || u.name} count={!x.active ? t`ne se vend plus` : String(x.capacityBase) === String(x.capacityMax) ? t`${x.capacityMax} personnes` : t`${x.capacityBase} à ${x.capacityMax} personnes`}>
              <div className="grid2">
                <TextInput size="md" label={t`Nom`} value={x.name} onChange={(e) => setU(u.id, { name: e.currentTarget.value })} />
                <NumberInput size="md" label={t`Frais de ménage (€)`} min={0} decimalScale={2} decimalSeparator="," value={x.cleaning} onChange={(v) => setU(u.id, { cleaning: v })} />
                <NumberInput size="md" label={t`Personnes, en temps normal`} min={1} value={x.capacityBase} onChange={(v) => setU(u.id, { capacityBase: v })} />
                <NumberInput size="md" label={t`Personnes, au plus`} min={1} value={x.capacityMax} onChange={(v) => setU(u.id, { capacityMax: v })} />
                <NumberInput size="md" label={t`Arrhes propres à ce bien (%)`} description={t`vide = ${f.set.deposit_pct} % comme le domaine`} min={0} max={100} value={x.deposit} onChange={(v) => setU(u.id, { deposit: v })} />
                {u.isComposite ? (
                  <Select
                    size="md"
                    label={t`Prix de ce bien`}
                    allowDeselect={false}
                    value={x.compositePricing}
                    onChange={(v) => setU(u.id, { compositePricing: v === "own" ? "own" : "sum" })}
                    data={[
                      { value: "sum", label: t`La somme des maisons qu'il regroupe` },
                      { value: "own", label: t`Ses propres prix` },
                    ]}
                  />
                ) : null}
              </div>
              <Textarea mt="sm" size="md" autosize minRows={2} label={t`Description sur le site`} value={x.description} onChange={(e) => setU(u.id, { description: e.currentTarget.value })} />
              {others.length ? (
                <fieldset className="wd">
                  <legend>{t`Réserver ce bien bloque aussi`}</legend>
                  {others.map((o) => (
                    <Checkbox
                      key={o.id}
                      size="md"
                      mt={6}
                      label={o.name}
                      checked={x.links.includes(o.id)}
                      onChange={(e) => setU(u.id, { links: (e.currentTarget.checked ? [...x.links, o.id] : x.links.filter((y) => y !== o.id)).sort((a, b) => a - b) })}
                    />
                  ))}
                </fieldset>
              ) : null}
              <Switch mt="md" size="md" label={t`Ce bien se vend`} checked={x.active} onChange={(e) => setU(u.id, { active: e.currentTarget.checked })} />
              <div className="acts" style={{ marginTop: 12 }}>
                <button type="button" className="btn" onClick={() => setPhotos(u)}>
                  <IconPhoto size={20} />
                  <Trans>Photos</Trans>
                </button>
              </div>
              <TextInput mt="sm" size="md" label={t`Photo de secours (adresse)`} description={t`servie seulement si le bien n'a pas de galerie`} value={x.photoUrl} onChange={(e) => setU(u.id, { photoUrl: e.currentTarget.value })} />
            </Fold>
          );
        })}
      </Section>

      <SaveBar dirty={dirty} busy={busy} error={error} onReset={() => setF(base)} onSave={() => void save()} />
      {photos ? <PhotosPanel unit={photos} onClose={() => setPhotos(null)} /> : null}
      <AddUnitBox open={adding} propertyId={propertyId} units={units} onClose={() => setAdding(false)} />
    </>
  );
}

function PhotosPanel({ unit, onClose }: { unit: UnitFull; onClose: () => void }) {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["photos", unit.id], queryFn: () => api<{ photos: Photo[] }>(`/units/${unit.id}/photos`).then((r) => r.photos) });
  const [list, setList] = useState<Photo[] | null>(null);
  useEffect(() => {
    if (q.data) setList(q.data);
  }, [q.data]);
  const [path, setPath] = useState("");
  const [alt, setAlt] = useState("");
  const [cap, setCap] = useState("");
  const a = useAction();
  const add = useAction();
  const dirty = !!list && !!q.data && !same(list, q.data);
  const move = (i: number, d: number) => {
    if (!list) return;
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const n = [...list];
    [n[i], n[j]] = [n[j]!, n[i]!];
    setList(n);
  };
  const missingAlt = list?.some((p) => p.alt.trim().length < 3);
  const putAll = () => api(`/units/${unit.id}/photos`, { method: "PUT", body: { photos: (list ?? []).map((p) => ({ id: p.id, alt: p.alt.trim(), caption: (p.caption ?? "").trim(), active: p.active })) } });
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Photos`}
      top={t`Photos`}
      title={unit.name}
      dirty={dirty || path.length > 0}
      actions={
        <button type="button" className="btn pri wide" disabled={!dirty || missingAlt || a.state.status === "busy"} onClick={() => void a.run(putAll, t`C'est fait. Ordre et textes des photos enregistrés.`)}>
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer l'ordre et les textes`}
        </button>
      }
    >
      <p className="lead">{t`L'ordre de la liste est l'ordre sur le site ; la première photo affichée sert de vignette. Le texte décrit la photo pour qui ne la voit pas : il est obligatoire.`}</p>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorLine text={t`Les photos n'ont pas pu être lues.`} /> : null}
      {missingAlt ? <ErrorLine text={t`Chaque photo doit avoir un texte d'au moins 3 lettres.`} /> : null}
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <ol className="photos">
        {(list ?? []).map((p, i) => (
          <li key={p.id} className={p.active ? "" : "off"}>
            <img src={p.path} alt="" width={96} height={72} />
            <div>
              <TextInput size="sm" label={t`Texte de la photo`} value={p.alt} onChange={(e) => setList(list!.map((x) => (x.id === p.id ? { ...x, alt: e.currentTarget.value } : x)))} />
              <TextInput size="sm" mt={6} label={t`Légende (facultatif)`} value={p.caption ?? ""} onChange={(e) => setList(list!.map((x) => (x.id === p.id ? { ...x, caption: e.currentTarget.value } : x)))} />
              <Switch mt={8} size="sm" label={t`Affichée`} checked={p.active} onChange={(e) => setList(list!.map((x) => (x.id === p.id ? { ...x, active: e.currentTarget.checked } : x)))} />
            </div>
            <div className="updown">
              <button type="button" className="btn icon" aria-label={t`Monter ${p.alt}`} disabled={i === 0} onClick={() => move(i, -1)}>
                <IconArrowUp size={20} />
              </button>
              <button type="button" className="btn icon" aria-label={t`Descendre ${p.alt}`} disabled={i === (list?.length ?? 0) - 1} onClick={() => move(i, 1)}>
                <IconArrowDown size={20} />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <Fold title={t`Rattacher une photo déjà déposée`}>
        <p className="hint">{t`Le fichier doit déjà être sur le site (dossier des images, préparé par le script d'optimisation). L'envoi d'une photo depuis l'ordinateur n'existe pas encore.`}</p>
        <TextInput size="md" label={t`Chemin du fichier`} placeholder="/img/gites/la-scierie/jardin.jpg" value={path} onChange={(e) => setPath(e.currentTarget.value)} />
        <TextInput mt="sm" size="md" label={t`Texte de la photo`} value={alt} onChange={(e) => setAlt(e.currentTarget.value)} />
        <TextInput mt="sm" size="md" label={t`Légende (facultatif)`} value={cap} onChange={(e) => setCap(e.currentTarget.value)} />
        <button
          type="button"
          className="btn"
          style={{ marginTop: 12 }}
          disabled={!path.trim() || alt.trim().length < 3 || add.state.status === "busy"}
          onClick={async () => {
            const ok = await add.run(async () => {
              if (dirty) await putAll();
              return api(`/units/${unit.id}/photos`, { method: "POST", body: { path: path.trim(), alt: alt.trim(), caption: cap.trim() } });
            }, t`C'est fait. Photo rattachée.`);
            if (ok) {
              setPath("");
              setAlt("");
              setCap("");
            }
          }}
        >
          {add.state.status === "busy" ? t`Un instant…` : t`Rattacher`}
        </button>
        {add.state.status === "error" ? <ErrorLine text={add.state.text} /> : null}
      </Fold>
    </SidePanel>
  );
}

function AddUnitBox({ open, propertyId, units, onClose }: { open: boolean; propertyId: number; units: UnitFull[]; onClose: () => void }) {
  const { t } = useLingui();
  const blank = { name: "", capB: 4 as number | string, capM: 6 as number | string, cleaning: 0 as number | string, week: "" as number | string, weekend: "" as number | string, min: 2 as number | string, composite: false, links: [] as number[] };
  const [v, setV] = useState(blank);
  const a = useAction();
  return (
    <Box open={open} onClose={onClose} title={t`Ajouter un bien`}>
      <p className="lead">{t`Une nouvelle maison, ou un ensemble vendu d'un bloc comme le Domaine entier.`}</p>
      <TextInput size="md" label={t`Nom`} placeholder={t`Par exemple : La Maison C`} value={v.name} onChange={(e) => setV({ ...v, name: e.currentTarget.value })} />
      <div className="grid2" style={{ marginTop: 12 }}>
        <NumberInput size="md" label={t`Personnes, en temps normal`} min={1} value={v.capB} onChange={(x) => setV({ ...v, capB: x })} />
        <NumberInput size="md" label={t`Personnes, au plus`} min={1} value={v.capM} onChange={(x) => setV({ ...v, capM: x })} />
        <NumberInput size="md" label={t`Frais de ménage (€)`} min={0} decimalScale={2} decimalSeparator="," value={v.cleaning} onChange={(x) => setV({ ...v, cleaning: x })} />
        <NumberInput size="md" label={t`Nuits minimum`} min={1} value={v.min} onChange={(x) => setV({ ...v, min: x })} />
        <NumberInput size="md" label={t`Nuit en semaine (€)`} description={t`facultatif : sans prix, le bien ne se vend pas`} min={1} decimalScale={2} decimalSeparator="," value={v.week} onChange={(x) => setV({ ...v, week: x })} />
        <NumberInput size="md" label={t`Nuit du week-end (€)`} min={1} decimalScale={2} decimalSeparator="," value={v.weekend} onChange={(x) => setV({ ...v, weekend: x })} />
      </div>
      <Switch mt="md" size="md" label={t`Ce bien regroupe plusieurs maisons (vendu d'un bloc)`} checked={v.composite} onChange={(e) => setV({ ...v, composite: e.currentTarget.checked })} />
      {units.length ? (
        <fieldset className="wd">
          <legend>{t`Le réserver bloque aussi`}</legend>
          {units.map((o) => (
            <Checkbox key={o.id} size="md" mt={6} label={o.name} checked={v.links.includes(o.id)} onChange={(e) => setV({ ...v, links: e.currentTarget.checked ? [...v.links, o.id] : v.links.filter((y) => y !== o.id) })} />
          ))}
        </fieldset>
      ) : null}
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={v.name.trim().length < 2 || a.state.status === "busy"}
          onClick={async () => {
            const week = parseEuros(v.week);
            const ok = await a.run(
              () =>
                api("/units", {
                  method: "POST",
                  body: {
                    propertyId,
                    name: v.name.trim(),
                    capacityBase: Number(v.capB) || 2,
                    capacityMax: Number(v.capM) || 2,
                    cleaningFeeCents: parseEuros(v.cleaning) ?? 0,
                    isComposite: v.composite,
                    compositePricing: v.composite ? "sum" : "own",
                    linkedUnitIds: v.links,
                    ...(week ? { priceWeekCents: week, priceWeekendCents: parseEuros(v.weekend) ?? week, minNights: Number(v.min) || 2 } : {}),
                  },
                }),
              t`C'est fait. Bien ${v.name.trim()} créé.`,
            );
            if (ok) {
              setV(blank);
              onClose();
            }
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Créer le bien`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}
