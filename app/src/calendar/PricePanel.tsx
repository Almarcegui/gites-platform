// Popover de la grille (maquette A, écran 3) : sur une nuit ou une plage,
// changer le prix (fixe ou relatif, « +10 % »), le minimum de nuits, bloquer
// ou vendre. Il contient des saisies : il ne se ferme jamais au clic à côté,
// seulement par « Annuler », la croix ou Échap.
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, TextInput } from "@mantine/core";
import { IconCheck, IconLock, IconTag, IconX } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api, errorText } from "../api/client";
import { useRefresh } from "../api/hooks";
import type { DayRate, IsoDate, RateCalendarUnit, Unit } from "../api/types";
import { ErrorLine } from "../lib/action";
import { addDays, diffDays, longDate } from "../lib/dates";
import { newPrice, priceRuns, type PriceChange } from "../lib/derive";
import { eur } from "../lib/money";
import { useToast } from "../lib/toasts";
import { useLayout } from "../lib/useLayout";

export interface RangeSelection {
  propertyId: number;
  unitId: number;
  /** première nuit */
  from: IsoDate;
  /** dernière nuit, incluse */
  to: IsoDate;
}

const PRESETS: { key: string; label: string; change: PriceChange }[] = [
  { key: "m10", label: "− 10 %", change: { kind: "pct", pct: -10 } },
  { key: "p10", label: "+ 10 %", change: { kind: "pct", pct: 10 } },
  { key: "p20", label: "+ 20 %", change: { kind: "pct", pct: 20 } },
  { key: "a15", label: "+ 15 €", change: { kind: "add", cents: 1500 } },
];

function daysIn(rates: RateCalendarUnit | undefined, from: IsoDate, to: IsoDate): DayRate[] {
  return (rates?.days ?? []).filter((d) => d.date >= from && d.date <= to);
}

export function PricePanel(props: {
  selection: RangeSelection;
  units: Unit[];
  rates: RateCalendarUnit[] | undefined;
  anchor: DOMRect | null;
  onClose: () => void;
  onSell: (s: RangeSelection) => void;
}) {
  const { t } = useLingui();
  const layout = useLayout();
  const toast = useToast();
  const refresh = useRefresh();
  const { selection: sel, units, rates } = props;
  const ref = useRef<HTMLDivElement>(null);
  const nights = diffDays(sel.from, sel.to) + 1;
  const editable = units.filter((u) => rates?.find((r) => r.unit.id === u.id)?.unit.editable !== false);
  const [chosen, setChosen] = useState<number[]>([sel.unitId]);
  const [mode, setMode] = useState<"set" | "rel">("rel");
  const [preset, setPreset] = useState<string>("p10");
  const [fixed, setFixed] = useState<number | string>("");
  const first = daysIn(rates?.find((r) => r.unit.id === sel.unitId), sel.from, sel.from)[0];
  const [minNights, setMinNights] = useState<number>(first?.minNights ?? 1);
  const [minTouched, setMinTouched] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    setChosen(editable.some((u) => u.id === sel.unitId) ? [sel.unitId] : editable.slice(0, 1).map((u) => u.id));
    setMinNights(first?.minNights ?? 1);
    setMinTouched(false);
    setError(null);
    setDone(null);
    setBlocking(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.unitId, sel.from, sel.to]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  useLayoutEffect(() => {
    if (layout === "B" || !props.anchor || !ref.current) return setPos(null);
    const w = ref.current.offsetWidth || 410;
    const h = ref.current.offsetHeight || 500;
    let left = props.anchor.right + 14;
    if (left + w > window.innerWidth - 12) left = Math.max(12, props.anchor.left - w - 14);
    const top = Math.max(12, Math.min(props.anchor.bottom + 8, window.innerHeight - h - 12));
    setPos({ left, top });
  }, [props.anchor, layout, sel.from, sel.to]);

  const change: PriceChange | null =
    mode === "set"
      ? Number(fixed) > 0
        ? { kind: "set", cents: Math.round(Number(fixed) * 100) }
        : null
      : (PRESETS.find((p) => p.key === preset)?.change ?? null);

  const preview = chosen.map((id) => {
    const u = units.find((x) => x.id === id);
    const days = daysIn(rates?.find((r) => r.unit.id === id), sel.from, sel.to);
    const olds = days.map((d) => d.priceCents).filter((x): x is number => x != null);
    const news = change ? days.map((d) => newPrice(d.priceCents, change)).filter((x): x is number => x != null) : [];
    const span = (xs: number[]) => (xs.length === 0 ? "—" : Math.min(...xs) === Math.max(...xs) ? eur(Math.min(...xs)) : `${eur(Math.min(...xs))} à ${eur(Math.max(...xs))}`);
    return { id, name: u?.name ?? "", old: span(olds), nw: change ? span(news) : null };
  });

  const title = nights > 1 ? t`Nuits du ${longDate(sel.from)} au ${longDate(sel.to)}` : t`Nuit du ${longDate(sel.from)}`;
  const sub = t`${nights > 1 ? t`${nights} nuits` : t`1 nuit`}, départ le ${longDate(addDays(sel.to, 1))}`;
  const total = nights * chosen.length;

  async function apply() {
    if (!change && !minTouched) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const failures: string[] = [];
    let ok = 0;
    let applied = 0; // nuits déjà changées, même si la suite échoue
    for (const id of chosen) {
      const name = units.find((u) => u.id === id)?.name ?? "";
      try {
        if (change) {
          const runs = priceRuns(daysIn(rates?.find((r) => r.unit.id === id), sel.from, sel.to), change);
          if (runs.length === 0) throw new Error(t`aucun prix de départ sur ces nuits`);
          for (const run of runs) {
            await api("/rate-overrides", {
              method: "PATCH",
              body: { unitId: id, from: run.from, to: run.to, priceCents: run.priceCents, ...(minTouched ? { minNights } : {}) },
            });
            applied += diffDays(run.from, run.to) + 1;
          }
        } else {
          await api("/rate-overrides", { method: "PATCH", body: { unitId: id, from: sel.from, to: sel.to, minNights } });
          applied += nights;
        }
        ok += 1;
      } catch (e) {
        failures.push(`${name} : ${errorText(e)}`);
      }
    }
    await refresh();
    setBusy(false);
    if (failures.length) {
      const msg = applied ? t`Changé en partie : ${applied} nuit(s) ont leur nouveau prix, le reste non. ${failures.join(" ")} Vérifiez la grille.` : t`Rien n'a été changé. ${failures.join(" ")}`;
      setError(msg);
      toast(msg, true);
    } else {
      const msg = change?.kind === "pct" ? t`C'est fait. ${PRESETS.find((p) => p.key === preset)?.label} sur ${total} nuits, arrondi aux 5 €.` : t`C'est fait. Prix enregistré sur ${total} nuits.`;
      setDone(msg);
      toast(msg);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      let done = 0;
      try {
        for (const id of chosen) {
          await api("/rate-overrides", { method: "DELETE", query: { unit: id, from: sel.from, to: sel.to } });
          done += 1;
        }
      } catch (e) {
        await refresh();
        throw new Error(done ? t`Fait pour ${done} bien(s) seulement : ${errorText(e)}` : errorText(e));
      }
      await refresh();
      const msg = t`C'est fait. Ces nuits reprennent le prix de la saison.`;
      setDone(msg);
      toast(msg);
    } catch (e) {
      setError(errorText(e));
      toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function block() {
    setBusy(true);
    setError(null);
    try {
      await api("/blocks", { method: "POST", body: { unitId: sel.unitId, checkin: sel.from, checkout: addDays(sel.to, 1), reason: reason.trim() } });
      await refresh();
      toast(t`C'est fait. Nuits bloquées : ${reason.trim()}.`);
      props.onClose();
    } catch (e) {
      setError(errorText(e));
      toast(errorText(e), true);
    } finally {
      setBusy(false);
    }
  }

  const unitName = units.find((u) => u.id === sel.unitId)?.name ?? "";
  const hasOverride = chosen.some((id) => daysIn(rates?.find((r) => r.unit.id === id), sel.from, sel.to).some((d) => d.overridePriceCents != null || d.overrideMinNights != null));

  return (
    <div
      ref={ref}
      className="pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby="pop-h"
      style={pos ? { left: pos.left, top: pos.top } : layout === "A" ? { visibility: "hidden", left: 0, top: 0 } : undefined}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <h3 id="pop-h">{title}</h3>
          <p className="sub">
            {unitName}, {sub}
          </p>
        </div>
        <button type="button" className="btn icon ghost" aria-label={t`Fermer`} onClick={props.onClose}>
          <IconX size={22} />
        </button>
      </div>

      {editable.length > 0 ? (
        <>
          <fieldset>
            <legend>
              <Trans>Biens concernés par le prix</Trans>
            </legend>
            <div className="chips">
              {editable.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="chip"
                  aria-pressed={chosen.includes(u.id)}
                  onClick={() => setChosen((xs) => (xs.includes(u.id) ? (xs.length > 1 ? xs.filter((x) => x !== u.id) : xs) : [...xs, u.id]))}
                >
                  <IconCheck size={18} />
                  {u.name}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="seg" role="group" aria-label={t`Façon de changer le prix`}>
            <button type="button" aria-pressed={mode === "set"} onClick={() => setMode("set")}>
              <Trans>Fixer un prix</Trans>
            </button>
            <button type="button" aria-pressed={mode === "rel"} onClick={() => setMode("rel")}>
              <Trans>Augmenter ou baisser</Trans>
            </button>
          </div>
          {mode === "rel" ? (
            <div className="chips" style={{ marginBottom: 12 }}>
              {PRESETS.map((p) => (
                <button key={p.key} type="button" className="chip" aria-pressed={preset === p.key} onClick={() => setPreset(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
          ) : (
            <NumberInput mb="sm" size="md" label={t`Prix de la nuit (€)`} min={1} value={fixed} onChange={setFixed} decimalScale={0} />
          )}
          <ul className="prev" aria-label={t`Aperçu des nouveaux prix`}>
            {preview.map((x) => (
              <li key={x.id}>
                <span>{x.name}</span>
                <span>
                  {x.nw ? (
                    <>
                      <s>{x.old}</s> &nbsp;{x.nw}
                    </>
                  ) : (
                    x.old
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="row2">
            <b>
              <Trans>Minimum de nuits</Trans>
            </b>
            <span className="step">
              <button type="button" aria-label={t`Une nuit de moins`} onClick={() => (setMinNights((n) => Math.max(1, n - 1)), setMinTouched(true))}>
                −
              </button>
              <output aria-live="polite">{minNights}</output>
              <button type="button" aria-label={t`Une nuit de plus`} onClick={() => (setMinNights((n) => Math.min(60, n + 1)), setMinTouched(true))}>
                +
              </button>
            </span>
          </div>
          <div className="acts">
            <button type="button" className="btn pri" disabled={busy || (!change && !minTouched)} aria-busy={busy} onClick={() => void apply()}>
              {busy ? t`Un instant…` : t`Appliquer à ${total} nuits`}
            </button>
            {hasOverride ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void reset()}>
                <Trans>Revenir au prix de saison</Trans>
              </button>
            ) : null}
            <button type="button" className="btn ghost" onClick={props.onClose}>
              <Trans>Annuler</Trans>
            </button>
          </div>
        </>
      ) : (
        <p className="lead">
          <Trans>Le prix de ce bien est la somme de ses maisons : changez le prix sur chaque maison.</Trans>
        </p>
      )}

      <div className="tabs-mini" style={{ marginTop: 16, borderTop: "1px solid var(--line-2)", paddingTop: 14 }}>
        <button type="button" className="btn" aria-expanded={blocking} onClick={() => setBlocking((b) => !b)}>
          <IconLock size={20} />
          <Trans>Bloquer ces nuits</Trans>
        </button>
        <button type="button" className="btn" onClick={() => props.onSell(sel)}>
          <IconTag size={20} />
          <Trans>Vendre ces nuits</Trans>
        </button>
      </div>
      {blocking ? (
        <div>
          <TextInput size="md" label={t`Pourquoi ? (travaux, famille…)`} value={reason} onChange={(e) => setReason(e.currentTarget.value)} data-autofocus />
          <div className="acts" style={{ marginTop: 10 }}>
            <button type="button" className="btn pri" disabled={busy || reason.trim().length < 2} onClick={() => void block()}>
              {busy ? t`Un instant…` : t`Bloquer ${nights > 1 ? t`${nights} nuits` : t`la nuit`}`}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 15, margin: "8px 0 0" }}>
            <Trans>Airbnb et Booking sont prévenus quand la liaison est active.</Trans>
          </p>
        </div>
      ) : null}
      {done ? (
        <div className="ok-line" role="status">
          <IconCheck size={20} />
          <span>{done}</span>
        </div>
      ) : null}
      {error ? <ErrorLine text={error} /> : null}
    </div>
  );
}
