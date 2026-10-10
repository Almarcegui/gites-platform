// Prix et saisons — tout ce que l'ancien « Calendrier › Prix » et « Année »
// savaient faire, dit en langage simple : le prix de base de chaque bien, les
// saisons (sans priorité numérique : la plus courte l'emporte), les prix fixés
// à la main, l'année en couleurs, les suggestions. Chaque élément s'ouvre en
// panneau latéral ; un panneau en cours de saisie ne se ferme pas tout seul.
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Switch, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { api, errorText } from "../../api/client";
import { useRefresh } from "../../api/hooks";
import type { DayRate, IsoDate } from "../../api/types";
import type { RateRule, Season, UnitFull } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { addDays, diffDays, longDate, monthShort, stayRange, todayBrussels } from "../../lib/dates";
import { eur } from "../../lib/money";
import { overlapsOf, overrideRuns, prioritiesToFix, priceLevels, seasonNights, wrongOverlaps, type OverrideRun } from "../../lib/seasons";
import { buildSuggestions, soldNights, type Suggestion } from "../../lib/suggestions";
import { Confirm, Empty, Fold, Loading, Page, parseEuros, Section, SidePanel, useWorkingProperty } from "../../ui/kit";
import { usePlanning, useRateCalendar, useRules, useSeasons, useUnitsFull } from "./useAdmin";

type Tab = "saisons" | "base" | "main" | "annee" | "idees";

const WEEKDAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Un bien qui a ses propres prix (un « Domaine entier » en somme des maisons n'en a pas). */
function ownPrices(u: UnitFull): boolean {
  return u.active && !(u.isComposite && u.compositePricing === "sum");
}

function useRuleText(): (r: RateRule) => string {
  const { t } = useLingui();
  return (r) => {
    const parts = [r.priceWeekendCents !== r.priceWeekCents ? t`${eur(r.priceWeekCents)} la nuit en semaine, ${eur(r.priceWeekendCents)} le week-end` : t`${eur(r.priceWeekCents)} la nuit`];
    if (r.holidayPct) parts.push(t`fériés + ${r.holidayPct} %`);
    parts.push(r.minNights > 1 ? t`au moins ${r.minNights} nuits` : t`dès 1 nuit`);
    if (r.checkinDays && r.checkinDays.length && r.checkinDays.length < 7) {
      const days = WEEK_ORDER.filter((d) => r.checkinDays!.includes(d)).map((d) => WEEKDAYS[d]).join(", ");
      parts.push(t`arrivée le ${days}`);
    }
    return parts.join(", ") + ".";
  };
}

export function TarifsPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const pid = property?.id;
  const [tab, setTab] = useState<Tab>("saisons");
  const units = useUnitsFull(pid);
  const seasons = useSeasons(pid);
  const rules = useRules(pid);
  const all = (units.data?.units ?? []).filter((u) => u.active).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const priced = all.filter(ownPrices);
  const err = units.error || seasons.error || rules.error;
  const tabs: { id: Tab; label: string }[] = [
    { id: "saisons", label: t`Saisons` },
    { id: "base", label: t`Prix de base` },
    { id: "main", label: t`Prix fixés à la main` },
    { id: "annee", label: t`L'année` },
    { id: "idees", label: t`Suggestions` },
  ];
  return (
    <Page title={t`Prix et saisons`} back tools={picker}>
      <div className="rule-box">
        <p>
          <b>
            <Trans>Comment se décide le prix d'une nuit</Trans>
          </b>
        </p>
        <ol>
          <li>
            <Trans>Un prix fixé à la main sur ce jour passe avant tout.</Trans>
          </li>
          <li>
            <Trans>Sinon, le prix de la saison qui couvre ce jour. Si deux saisons se chevauchent, la plus courte l'emporte.</Trans>
          </li>
          <li>
            <Trans>Sinon, le prix de base du bien.</Trans>
          </li>
        </ol>
        <p className="muted">
          <Trans>Le week-end, ce sont les nuits du vendredi et du samedi. Les jours fériés belges, leurs veilles et les ponts sont majorés tout seuls du pourcentage choisi.</Trans>{" "}
          <Link to="/reglages/plateformes">
            <Trans>Prix envoyés à Airbnb et Booking</Trans>
          </Link>
        </p>
      </div>
      <div className="tabs" role="tablist" aria-label={t`Partie des prix`}>
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      {err ? <ErrorLine text={t`Les prix n'ont pas pu être lus. Rechargez la page.`} /> : null}
      {!pid || units.isLoading || seasons.isLoading || rules.isLoading ? <Loading /> : null}
      {pid && units.data && seasons.data && rules.data ? (
        <>
          {tab === "saisons" ? <SeasonsTab propertyId={pid} units={priced} seasons={seasons.data} rules={rules.data} /> : null}
          {tab === "base" ? <BaseTab units={all} rules={rules.data} /> : null}
          {tab === "main" ? <ManualTab propertyId={pid} units={priced} /> : null}
          {tab === "annee" ? <YearTab propertyId={pid} units={all} /> : null}
          {tab === "idees" ? <IdeasTab propertyId={pid} units={priced} /> : null}
        </>
      ) : null}
    </Page>
  );
}

// --- champs de prix -------------------------------------------------------------------

interface RuleForm {
  week: number | string;
  weekend: number | string;
  holiday: number | string;
  min: number | string;
  days: number[] | null;
}

function formOf(r: RateRule | undefined, fallback?: RateRule): RuleForm {
  const src = r ?? fallback;
  return {
    week: src ? src.priceWeekCents / 100 : "",
    weekend: src ? src.priceWeekendCents / 100 : "",
    holiday: src ? src.holidayPct : 15,
    min: src ? src.minNights : 2,
    days: src?.checkinDays && src.checkinDays.length && src.checkinDays.length < 7 ? [...src.checkinDays] : null,
  };
}

function sameForm(a: RuleForm, b: RuleForm): boolean {
  return String(a.week) === String(b.week) && String(a.weekend) === String(b.weekend) && String(a.holiday) === String(b.holiday) && String(a.min) === String(b.min) && JSON.stringify(a.days ?? null) === JSON.stringify(b.days ?? null);
}

function ruleBody(f: RuleForm) {
  const week = parseEuros(f.week);
  return {
    priceWeekCents: week,
    priceWeekendCents: parseEuros(f.weekend) ?? week,
    holidayPct: Math.max(0, Math.round(Number(f.holiday) || 0)),
    minNights: Math.max(1, Math.round(Number(f.min) || 1)),
    checkinDays: f.days && f.days.length ? f.days : null,
  };
}

function RuleFields({ f, set, idPrefix }: { f: RuleForm; set: (f: RuleForm) => void; idPrefix: string }) {
  const { t } = useLingui();
  return (
    <div className="grid2">
      <NumberInput id={`${idPrefix}-w`} size="md" label={t`Nuit en semaine (€)`} min={1} decimalScale={2} decimalSeparator="," value={f.week} onChange={(v) => set({ ...f, week: v })} />
      <NumberInput id={`${idPrefix}-we`} size="md" label={t`Nuit du week-end (€)`} description={t`vendredi et samedi`} min={1} decimalScale={2} decimalSeparator="," value={f.weekend} onChange={(v) => set({ ...f, weekend: v })} />
      <NumberInput id={`${idPrefix}-h`} size="md" label={t`Majoration des fériés (%)`} min={0} max={200} value={f.holiday} onChange={(v) => set({ ...f, holiday: v })} />
      <NumberInput id={`${idPrefix}-m`} size="md" label={t`Nuits minimum`} min={1} max={60} value={f.min} onChange={(v) => set({ ...f, min: v })} />
      <fieldset className="wd" style={{ gridColumn: "1 / -1" }}>
        <legend>
          <Trans>Jours où l'on peut arriver</Trans>
        </legend>
        <div className="chips">
          <button type="button" className="chip" aria-pressed={f.days == null} onClick={() => set({ ...f, days: null })}>
            <Trans>Tous les jours</Trans>
          </button>
          {WEEK_ORDER.map((d) => {
            const on = f.days?.includes(d) ?? false;
            return (
              <button
                key={d}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={() => {
                  const cur = f.days ?? [];
                  const next = on ? cur.filter((x) => x !== d) : [...cur, d];
                  set({ ...f, days: next.length === 0 || next.length === 7 ? null : next });
                }}
              >
                {WEEKDAYS[d]}
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

// --- prix de base ------------------------------------------------------------------------

function BaseTab({ units, rules }: { units: UnitFull[]; rules: RateRule[] }) {
  const { t } = useLingui();
  const ruleSentence = useRuleText();
  const [open, setOpen] = useState<UnitFull | null>(null);
  return (
    <Section title={t`Prix de base`} hint={t`Le prix de chaque bien en dehors des saisons. Touchez un bien pour le changer.`}>
      <div className="panel">
        {units.map((u) => {
          const r = rules.find((x) => x.unitId === u.id && x.seasonId == null);
          const own = ownPrices(u);
          return (
            <button key={u.id} type="button" className="list-row two" disabled={!own} onClick={() => setOpen(u)}>
              <span>
                <b>{u.name}</b>
                <small>{!own ? t`Prix = somme des deux maisons : rien à régler ici.` : r ? ruleSentence(r) : t`Pas encore de prix de base : ce bien ne se vend pas.`}</small>
              </span>
              {own ? <span className="go">{r ? t`Changer` : t`Fixer le prix`}</span> : null}
            </button>
          );
        })}
      </div>
      {open ? <BasePanel unit={open} rule={rules.find((x) => x.unitId === open.id && x.seasonId == null)} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

function BasePanel({ unit, rule, onClose }: { unit: UnitFull; rule: RateRule | undefined; onClose: () => void }) {
  const { t } = useLingui();
  const initial = useMemo(() => formOf(rule), [rule]);
  const [f, setF] = useState(initial);
  const a = useAction();
  const dirty = !sameForm(f, initial);
  const body = ruleBody(f);
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Prix de base`}
      top={t`Prix de base`}
      title={unit.name}
      dirty={dirty}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!dirty || !body.priceWeekCents || a.state.status === "busy"}
          onClick={async () => {
            const ok = await a.run(
              () => (rule ? api(`/rate-rules/${rule.id}`, { method: "PATCH", body }) : api("/rate-rules", { method: "POST", body: { ...body, unitId: unit.id, seasonId: null } })),
              t`C'est fait. Prix de base de ${unit.name} enregistré.`,
            );
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
        </button>
      }
    >
      <p className="lead">{t`S'applique à toutes les nuits qui ne sont ni dans une saison, ni fixées à la main.`}</p>
      <RuleFields f={f} set={setF} idPrefix="base" />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </SidePanel>
  );
}

// --- saisons -----------------------------------------------------------------------------

async function applyPriorities(propertyId: number): Promise<number> {
  const { seasons } = await api<{ seasons: Season[] }>("/seasons", { query: { property: propertyId } });
  const fix = prioritiesToFix(seasons);
  for (const f of fix) await api(`/seasons/${f.id}`, { method: "PATCH", body: { priority: f.priority } });
  return fix.length;
}

function SeasonsTab({ propertyId, units, seasons, rules }: { propertyId: number; units: UnitFull[]; seasons: Season[]; rules: RateRule[] }) {
  const { t } = useLingui();
  const ruleSentence = useRuleText();
  const [open, setOpen] = useState<Season | "new" | null>(null);
  const wrong = wrongOverlaps(seasons);
  const reorder = useAction();
  const today = todayBrussels();
  const sorted = [...seasons].sort((a, b) => (a.dateStart < b.dateStart ? -1 : 1));
  const current = sorted.filter((s) => s.dateEnd >= today);
  const past = sorted.filter((s) => s.dateEnd < today);
  const row = (s: Season) => {
    const ov = overlapsOf(s, seasons);
    const sRules = rules.filter((r) => r.seasonId === s.id);
    return (
      <button key={s.id} type="button" className="list-row two" onClick={() => setOpen(s)}>
        <span>
          <b>{s.name}</b>
          <small>{t`Du ${longDate(s.dateStart)} au ${longDate(s.dateEnd)} (${seasonNights(s)} nuits)`}</small>
          {units.map((u) => {
            const r = sRules.find((x) => x.unitId === u.id);
            return (
              <small key={u.id}>
                {u.name} : {r ? ruleSentence(r) : t`garde son prix de base.`}
              </small>
            );
          })}
          {ov.length ? <small className="note-ov">{t`Chevauche ${ov.map((o) => o.name).join(", ")} : la plus courte l'emporte sur les jours communs.`}</small> : null}
        </span>
        <span className="go">
          <Trans>Ouvrir</Trans>
        </span>
      </button>
    );
  };
  return (
    <Section
      title={t`Saisons`}
      hint={t`Une saison donne d'autres prix sur une période de l'année. Pour un ou deux jours, fixez plutôt le prix à la main depuis le calendrier.`}
      tools={
        <button type="button" className="btn pri" onClick={() => setOpen("new")}>
          <IconPlus size={20} />
          <Trans>Nouvelle saison</Trans>
        </button>
      }
    >
      {wrong.length ? (
        <div className="alert" role="status">
          <IconAlertTriangle size={22} />
          <p>
            {t`Réglé dans l'ancien écran, l'ordre ne suit pas la règle : ${wrong.map((w) => t`${w.longer.name} passe devant ${w.shorter.name}`).join(" ; ")}. Rangez pour que la plus courte l'emporte.`}
          </p>
          <button
            type="button"
            className="btn"
            disabled={reorder.state.status === "busy"}
            onClick={() => void reorder.run(() => applyPriorities(propertyId), t`C'est fait. La saison la plus courte l'emporte désormais.`)}
          >
            {reorder.state.status === "busy" ? t`Un instant…` : t`Ranger selon la règle`}
          </button>
        </div>
      ) : null}
      {reorder.state.status === "error" ? <ErrorLine text={reorder.state.text} /> : null}
      {seasons.length === 0 ? (
        <Empty title={t`Aucune saison`}>
          <p>{t`Toute l'année se vend au prix de base. Créez une saison pour l'été, les vacances ou les fêtes.`}</p>
        </Empty>
      ) : (
        <div className="panel">
          {current.map(row)}
        </div>
      )}
      {past.length ? (
        <Fold title={t`Saisons passées`} count={String(past.length)}>
          <div className="panel">
            {past.map(row)}
          </div>
        </Fold>
      ) : null}
      {open ? <SeasonPanel propertyId={propertyId} season={open === "new" ? null : open} units={units} rules={rules} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

function SeasonPanel({ propertyId, season, units, rules, onClose }: { propertyId: number; season: Season | null; units: UnitFull[]; rules: RateRule[]; onClose: () => void }) {
  const { t } = useLingui();
  const today = todayBrussels();
  const init = useMemo(() => {
    const start = season?.dateStart ?? today;
    return {
      name: season?.name ?? "",
      from: start,
      to: season?.dateEnd ?? addDays(start, 30),
      per: Object.fromEntries(
        units.map((u) => {
          const r = season ? rules.find((x) => x.unitId === u.id && x.seasonId === season.id) : undefined;
          const base = rules.find((x) => x.unitId === u.id && x.seasonId == null);
          return [u.id, { on: season ? !!r : true, f: formOf(r, base) }];
        }),
      ) as Record<number, { on: boolean; f: RuleForm }>,
    };
  }, [season, units, rules, today]);
  const [v, setV] = useState(init);
  const [asking, setAsking] = useState(false);
  const a = useAction();
  const del = useAction();
  const dirty = v.name !== init.name || v.from !== init.from || v.to !== init.to || units.some((u) => v.per[u.id]!.on !== init.per[u.id]!.on || (v.per[u.id]!.on && !sameForm(v.per[u.id]!.f, init.per[u.id]!.f)));
  const datesOk = !!v.from && !!v.to && v.from <= v.to;
  const pricesOk = units.every((u) => !v.per[u.id]!.on || !!parseEuros(v.per[u.id]!.f.week));
  const valid = v.name.trim().length >= 2 && datesOk && pricesOk;

  const refresh = useRefresh();
  async function save() {
    let id = season?.id;
    let created = false;
    if (!id) {
      const r = await api<{ id: number }>("/seasons", { method: "POST", query: { property: propertyId }, body: { name: v.name.trim(), dateStart: v.from, dateEnd: v.to, priority: 0 } });
      id = r.id;
      created = true;
    }
    try {
      await saveRest(id, created);
    } catch (e) {
      // Plusieurs écritures, pas de transaction : on ne laisse jamais une
      // saison à moitié créée, et on dit ce qui est resté.
      if (created) {
        let undone = false;
        try {
          await api(`/seasons/${id}`, { method: "DELETE" });
          undone = true;
        } catch {
          /* dit ci-dessous */
        }
        await refresh();
        throw new Error(undone ? t`La saison n'a pas été créée : ${errorText(e)}` : t`La saison a été créée mais ses prix n'ont pas tous été enregistrés (${errorText(e)}). Ouvrez-la pour vérifier.`);
      }
      await refresh();
      throw new Error(t`Enregistré en partie : ${errorText(e)} Rouvrez la saison pour vérifier ses prix.`);
    }
  }

  async function saveRest(id: number, created: boolean) {
    if (!created && (v.name !== init.name || v.from !== init.from || v.to !== init.to)) {
      await api(`/seasons/${id}`, { method: "PATCH", body: { name: v.name.trim(), dateStart: v.from, dateEnd: v.to } });
    }
    for (const u of units) {
      const want = v.per[u.id]!;
      const had = season ? rules.find((x) => x.unitId === u.id && x.seasonId === season.id) : undefined;
      if (want.on && had && !sameForm(want.f, init.per[u.id]!.f)) await api(`/rate-rules/${had.id}`, { method: "PATCH", body: ruleBody(want.f) });
      else if (want.on && !had) await api("/rate-rules", { method: "POST", body: { ...ruleBody(want.f), unitId: u.id, seasonId: id } });
      else if (!want.on && had) await api(`/rate-rules/${had.id}`, { method: "DELETE" });
    }
    await applyPriorities(propertyId);
  }

  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Saison`}
      top={season ? t`Saison` : t`Nouvelle saison`}
      title={v.name.trim() || t`Saison sans nom`}
      dirty={dirty}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!valid || (!dirty && !!season) || a.state.status === "busy"}
          onClick={async () => {
            if (await a.run(save, season ? t`C'est fait. Saison ${v.name.trim()} enregistrée.` : t`C'est fait. Saison ${v.name.trim()} créée.`)) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : season ? t`Enregistrer` : t`Créer la saison`}
        </button>
      }
      more={season ? [{ label: t`Supprimer la saison`, danger: true, onClick: () => setAsking(true) }] : []}
    >
      <TextInput size="md" label={t`Nom`} placeholder={t`Par exemple : Été, Vacances de Noël`} value={v.name} onChange={(e) => setV({ ...v, name: e.currentTarget.value })} />
      <div className="grid2" style={{ marginTop: 12 }}>
        <TextInput size="md" type="date" label={t`Première nuit`} value={v.from} onChange={(e) => setV({ ...v, from: e.currentTarget.value })} />
        <TextInput size="md" type="date" label={t`Dernière nuit`} value={v.to} onChange={(e) => setV({ ...v, to: e.currentTarget.value })} />
      </div>
      {!datesOk ? <ErrorLine text={t`La dernière nuit doit venir après la première.`} /> : <p className="hint">{t`${diffDays(v.from, v.to) + 1} nuits. Si une autre saison couvre aussi ces jours, la plus courte l'emporte.`}</p>}
      {units.map((u) => {
        const p = v.per[u.id]!;
        return (
          <div key={u.id} className="sub-blk">
            <Switch
              size="md"
              checked={p.on}
              onChange={(e) => setV({ ...v, per: { ...v.per, [u.id]: { ...p, on: e.currentTarget.checked } } })}
              label={<b>{t`${u.name} a ses prix de saison`}</b>}
              description={p.on ? undefined : t`Pendant cette saison, ${u.name} garde son prix de base.`}
            />
            {p.on ? (
              <div style={{ marginTop: 10 }}>
                <RuleFields f={p.f} set={(f) => setV({ ...v, per: { ...v.per, [u.id]: { ...p, f } } })} idPrefix={`s${u.id}`} />
              </div>
            ) : null}
          </div>
        );
      })}
      {!pricesOk ? <ErrorLine text={t`Indiquez le prix d'une nuit en semaine pour chaque bien qui a ses prix de saison.`} /> : null}
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={asking}
        title={t`Supprimer la saison ${season?.name ?? ""} ?`}
        text={t`Ses prix disparaissent pour tous les biens ; ces jours-là reviennent au prix de base (ou à une autre saison).`}
        yes={t`Supprimer la saison`}
        no={t`Garder la saison`}
        danger
        busy={del.state.status === "busy"}
        onNo={() => setAsking(false)}
        onYes={async () => {
          const ok = await del.run(async () => {
            await api(`/seasons/${season!.id}`, { method: "DELETE" });
            await applyPriorities(propertyId);
          }, t`C'est fait. Saison supprimée.`);
          setAsking(false);
          if (ok) onClose();
        }}
      />
      {del.state.status === "error" ? <ErrorLine text={del.state.text} /> : null}
    </SidePanel>
  );
}

// --- prix fixés à la main ------------------------------------------------------------------

export interface DayEdit {
  unit: { id: number; name: string };
  from: IsoDate;
  to: IsoDate;
  priceCents: number | null;
  minNights: number | null;
  fallbackCents: number | null;
  prefill?: { priceCents?: number; minNights?: number };
  why?: string;
}

function ManualTab({ propertyId, units }: { propertyId: number; units: UnitFull[] }) {
  const { t } = useLingui();
  const today = todayBrussels();
  const cal = useRateCalendar(propertyId, today, addDays(today, 400));
  const [open, setOpen] = useState<DayEdit | null>(null);
  const runs: OverrideRun[] = (cal.data ?? []).filter((x) => units.some((u) => u.id === x.unit.id)).flatMap((x) => overrideRuns(x.unit.id, x.days));
  const name = (id: number) => units.find((u) => u.id === id)?.name ?? "";
  return (
    <Section title={t`Prix fixés à la main`} hint={t`Les jours où un prix ou un minimum a été posé depuis le calendrier. Ils passent avant les saisons.`}>
      {cal.isLoading ? <Loading /> : null}
      {cal.error ? <ErrorLine text={t`Les prix n'ont pas pu être lus.`} /> : null}
      {cal.data && runs.length === 0 ? (
        <Empty title={t`Rien de fixé à la main`}>
          <p>{t`Toutes les nuits à venir suivent les saisons et le prix de base. Pour changer un jour, touchez-le dans le calendrier.`}</p>
        </Empty>
      ) : null}
      {runs.length ? (
        <div className="panel">
          {runs.map((r) => (
            <button key={`${r.unitId}${r.from}`} type="button" className="list-row two" onClick={() => setOpen({ unit: { id: r.unitId, name: name(r.unitId) }, ...r })}>
              <span>
                <b>{name(r.unitId)}</b>
                <small>{r.from === r.to ? t`Nuit du ${longDate(r.from)}` : t`Nuits du ${longDate(r.from)} au ${longDate(r.to)}`}</small>
              </span>
              <span style={{ textAlign: "right" }}>
                {r.priceCents != null ? <b className="num">{eur(r.priceCents)}</b> : null}
                <small>
                  {[r.fallbackCents != null && r.priceCents != null ? t`au lieu de ${eur(r.fallbackCents)}` : "", r.minNights != null ? t`${r.minNights} nuits min.` : ""].filter(Boolean).join(", ")}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {open ? <DayPanel edit={open} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

/** Prix et minimum sur un jour ou une plage : poser, changer, ou revenir au
 *  prix de saison. Sert aux prix fixés à la main, à l'année et aux suggestions. */
export function DayPanel({ edit, onClose }: { edit: DayEdit; onClose: () => void }) {
  const { t } = useLingui();
  const initPrice = edit.prefill?.priceCents ?? edit.priceCents;
  const initMin = edit.prefill?.minNights ?? edit.minNights;
  const [price, setPrice] = useState<number | string>(initPrice != null ? initPrice / 100 : "");
  const [min, setMin] = useState<number | string>(initMin ?? "");
  useEffect(() => {
    setPrice(initPrice != null ? initPrice / 100 : "");
    setMin(initMin ?? "");
  }, [initPrice, initMin]);
  const a = useAction();
  const clear = useAction();
  const cents = parseEuros(price);
  const minN = min === "" ? null : Math.round(Number(min));
  const body: Record<string, unknown> = { unitId: edit.unit.id, from: edit.from, to: edit.to };
  if (cents != null) body.priceCents = cents;
  else if (edit.priceCents != null) body.priceCents = null;
  if (minN != null) body.minNights = minN;
  else if (edit.minNights != null) body.minNights = null;
  const changed = cents !== edit.priceCents || minN !== edit.minNights;
  const hasOverride = edit.priceCents != null || edit.minNights != null;
  const nights = diffDays(edit.from, edit.to) + 1;
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Prix du jour`}
      top={edit.unit.name}
      title={edit.from === edit.to ? t`Nuit du ${longDate(edit.from)}` : stayRange(edit.from, addDays(edit.to, 1))}
      dirty={changed}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={!changed || a.state.status === "busy" || (cents == null && minN == null && !hasOverride)}
          onClick={async () => {
            if (await a.run(() => api("/rate-overrides", { method: "PATCH", body }), t`C'est fait. Prix enregistré sur ${nights > 1 ? t`${nights} nuits` : t`1 nuit`}.`)) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Enregistrer`}
        </button>
      }
      more={[
        {
          label: t`Revenir au prix de saison`,
          hidden: !hasOverride,
          onClick: async () => {
            if (await clear.run(() => api("/rate-overrides", { method: "DELETE", query: { unit: edit.unit.id, from: edit.from, to: edit.to } }), t`C'est fait. Ces nuits suivent de nouveau la saison.`)) onClose();
          },
        },
      ]}
    >
      {edit.why ? <p className="lead">{edit.why}</p> : null}
      {edit.fallbackCents != null ? <p className="lead">{t`Sans prix fixé à la main : ${eur(edit.fallbackCents)} la nuit.`}</p> : null}
      <div className="grid2">
        <NumberInput size="md" label={t`Prix de la nuit (€)`} description={t`vide = prix de saison`} min={1} decimalScale={2} decimalSeparator="," value={price} onChange={setPrice} />
        <NumberInput size="md" label={t`Nuits minimum à l'arrivée`} description={t`vide = celui de la saison`} min={1} max={60} value={min} onChange={setMin} />
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      {clear.state.status === "error" ? <ErrorLine text={clear.state.text} /> : null}
    </SidePanel>
  );
}

// --- l'année ---------------------------------------------------------------------------------

function YearTab({ propertyId, units }: { propertyId: number; units: UnitFull[] }) {
  const { t } = useLingui();
  const today = todayBrussels();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const cal = useRateCalendar(propertyId, from, to);
  const plan = usePlanning(propertyId, from, to);
  const [open, setOpen] = useState<DayEdit | null>(null);
  return (
    <Section
      title={t`L'année ${year}`}
      hint={t`Une case par nuit, plus foncée quand le prix est plus haut. Touchez une case pour lire ou changer son prix.`}
      tools={
        <div className="acts">
          <button type="button" className="btn" onClick={() => setYear(year - 1)}>
            {year - 1}
          </button>
          <button type="button" className="btn" onClick={() => setYear(year + 1)}>
            {year + 1}
          </button>
        </div>
      }
    >
      {cal.isLoading || plan.isLoading ? <Loading /> : null}
      {cal.error || plan.error ? <ErrorLine text={t`L'année n'a pas pu être lue.`} /> : null}
      {cal.data && plan.data
        ? cal.data
            .filter((x) => units.some((u) => u.id === x.unit.id))
            .map((x) => {
              const sold = soldNights(plan.data, x.unit.id);
              const { cuts, distinct, level } = priceLevels(x.days.map((d) => d.priceCents));
              const byDate = new Map(x.days.map((d) => [d.date, d]));
              const missing = x.days.filter((d) => d.priceCents == null).length;
              return (
                <div key={x.unit.id} className="year">
                  <h3>
                    {x.unit.name}
                    {x.unit.editable === false ? <small>{t` — somme des maisons, se lit seulement`}</small> : null}
                  </h3>
                  {missing ? <p className="warn">{t`${missing} nuits sans prix en ${year} : elles ne se vendent pas.`}</p> : null}
                  <div className="yr" role="grid" aria-label={t`Prix ${year}, ${x.unit.name}`}>
                    <div role="row" className="yrow">
                      <span className="ym" />
                      {Array.from({ length: 31 }, (_, i) => (
                        <span key={i} role="columnheader" className="yh">
                          {i + 1}
                        </span>
                      ))}
                    </div>
                    {Array.from({ length: 12 }, (_, m) => {
                      const ym = `${year}-${String(m + 1).padStart(2, "0")}`;
                      return (
                        <div key={ym} role="row" className="yrow">
                          <span role="rowheader" className="ym">
                            {monthShort(`${ym}-01`)}
                          </span>
                          {Array.from({ length: 31 }, (_, i) => {
                            const iso = `${ym}-${String(i + 1).padStart(2, "0")}`;
                            const d: DayRate | undefined = byDate.get(iso);
                            if (!d || iso.slice(0, 7) !== ym || new Date(`${iso}T12:00:00Z`).getUTCMonth() !== m) return <span key={i} className="yc off" />;
                            const cls = ["yc", d.priceCents == null ? "norate" : `lv${level(d.priceCents)}`, sold.has(iso) ? "sold" : "", d.overridePriceCents != null ? "ov" : "", iso === today ? "now" : ""].filter(Boolean).join(" ");
                            const label = `${longDate(iso)} : ${d.priceCents == null ? t`pas de prix` : eur(d.priceCents)}${sold.has(iso) ? t`, vendue` : ""}${d.overridePriceCents != null ? t`, fixé à la main` : ""}`;
                            return (
                              <button
                                key={i}
                                type="button"
                                role="gridcell"
                                className={cls}
                                aria-label={label}
                                title={label}
                                disabled={x.unit.editable === false || iso < today}
                                onClick={() => setOpen({ unit: { id: x.unit.id, name: x.unit.name }, from: iso, to: iso, priceCents: d.overridePriceCents, minNights: d.overrideMinNights, fallbackCents: d.fallbackPriceCents ?? d.priceCents })}
                              />
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                  <div className="ylegend">
                    {distinct.length === 0 ? (
                      <span>{t`Aucun prix sur ${year}.`}</span>
                    ) : cuts.length === 0 ? (
                      distinct.map((c, i) => (
                        <span key={c}>
                          <i className={`lv${i}`} />
                          {eur(c)}
                        </span>
                      ))
                    ) : (
                      <>
                        <span>
                          <i className="lv0" />
                          {t`moins de ${eur(cuts[0]!)}`}
                        </span>
                        <span>
                          <i className="lv1" />
                          {t`${eur(cuts[0]!)} à ${eur(cuts[1]!)}`}
                        </span>
                        <span>
                          <i className="lv2" />
                          {t`${eur(cuts[1]!)} à ${eur(cuts[2]!)}`}
                        </span>
                        <span>
                          <i className="lv3" />
                          {t`${eur(cuts[2]!)} et plus`}
                        </span>
                      </>
                    )}
                    <span>
                      <i className="sold" />
                      {t`nuit vendue`}
                    </span>
                    <span>
                      <i className="ov" />
                      {t`fixé à la main`}
                    </span>
                  </div>
                </div>
              );
            })
        : null}
      {open ? <DayPanel edit={open} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

// --- suggestions -------------------------------------------------------------------------------

function IdeasTab({ propertyId, units }: { propertyId: number; units: UnitFull[] }) {
  const { t } = useLingui();
  const today = todayBrussels();
  const end = addDays(today, 31);
  const cal = useRateCalendar(propertyId, today, addDays(end, 1));
  const plan = usePlanning(propertyId, addDays(today, -30), addDays(end, 31));
  const [open, setOpen] = useState<DayEdit | null>(null);
  const [runs, setRuns] = useState<{ unit: UnitFull; s: Suggestion } | null>(null);
  const list: { unit: UnitFull; s: Suggestion; days: DayRate[] }[] = [];
  if (cal.data && plan.data) {
    for (const u of units) {
      const x = cal.data.find((c) => c.unit.id === u.id);
      if (!x) continue;
      const bookings = plan.data.bookings.filter((b) => b.status !== "cancelled");
      for (const s of buildSuggestions({ days: x.days, soldDates: soldNights(plan.data, u.id), bookings, unitId: u.id, today, monthEnd: end })) list.push({ unit: u, s, days: x.days });
    }
  }
  return (
    <Section title={t`Suggestions`} hint={t`Calculées sur vos réservations et vos prix des 31 prochains jours. Un bouton prépare le changement ; rien ne s'enregistre sans vous.`}>
      {cal.isLoading || plan.isLoading ? <Loading /> : null}
      {cal.error || plan.error ? <ErrorLine text={t`Les suggestions n'ont pas pu être calculées.`} /> : null}
      {cal.data && plan.data && list.length === 0 ? (
        <Empty title={t`Rien à suggérer`}>
          <p>{t`Pas de nuit coincée entre deux séjours, pas de dates proches à brader, pas de férié à relever dans le mois qui vient.`}</p>
        </Empty>
      ) : null}
      <div className="ideas">
        {list.map(({ unit, s, days }) => {
          const first = days.find((d) => d.date === s.from);
          return (
            <article key={`${unit.id}${s.kind}`} className="idea">
              <small>{unit.name}</small>
              <h3>{s.title}</h3>
              <p>{s.why}</p>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  s.runs
                    ? setRuns({ unit, s })
                    : setOpen({ unit: { id: unit.id, name: unit.name }, from: s.from, to: s.to, priceCents: first?.overridePriceCents ?? null, minNights: first?.overrideMinNights ?? null, fallbackCents: first?.priceCents ?? null, prefill: s.prefill, why: s.why })
                }
              >
                {s.action}
              </button>
            </article>
          );
        })}
      </div>
      {open ? <DayPanel edit={open} onClose={() => setOpen(null)} /> : null}
      {runs ? <RunsPanel unit={runs.unit} s={runs.s} onClose={() => setRuns(null)} /> : null}
    </Section>
  );
}

/** Une suggestion de prix : la liste exacte des nuits qui changeront, puis un
 *  geste pour les appliquer. Rien d'autre ne bouge. */
function RunsPanel({ unit, s, onClose }: { unit: UnitFull; s: Suggestion; onClose: () => void }) {
  const { t } = useLingui();
  const refresh = useRefresh();
  const a = useAction();
  const runs = s.runs ?? [];
  const nights = runs.reduce((n, r) => n + diffDays(r.from, r.to) + 1, 0);
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Suggestion`}
      top={unit.name}
      title={s.title}
      actions={
        <button
          type="button"
          className="btn pri wide"
          disabled={a.state.status === "busy" || nights === 0}
          onClick={async () => {
            let done = 0;
            const ok = await a.run(async () => {
              try {
                for (const r of runs) {
                  await api("/rate-overrides", { method: "PATCH", body: { unitId: unit.id, from: r.from, to: r.to, priceCents: r.priceCents } });
                  done += diffDays(r.from, r.to) + 1;
                }
              } catch (e) {
                await refresh();
                throw new Error(done ? t`Appliqué en partie : ${done} nuit(s) sur ${nights}. ${errorText(e)}` : errorText(e));
              }
            }, t`C'est fait. Prix changé sur ${nights} nuit(s).`);
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Appliquer à ${nights} nuit(s)`}
        </button>
      }
    >
      <p className="lead">{s.why}</p>
      <ul className="plain-list">
        {runs.map((r) => (
          <li key={r.from}>
            {r.from === r.to ? t`Nuit du ${longDate(r.from)}` : t`Du ${longDate(r.from)} au ${longDate(r.to)}`} : <b>{eur(r.priceCents)}</b>
          </li>
        ))}
      </ul>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </SidePanel>
  );
}
