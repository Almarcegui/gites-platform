// Calendrier en semaines empilées (maquette B, téléphone) : on touche le
// premier jour, puis le jour de départ, puis on choisit quoi faire.
import { Trans, useLingui } from "@lingui/react/macro";
import { TextInput } from "@mantine/core";
import { IconCheck, IconCurrencyEuro, IconLock, IconTag } from "@tabler/icons-react";
import { Fragment, useState } from "react";

import { api, errorText } from "../api/client";
import { useRefresh, type DomainData } from "../api/hooks";
import type { IsoDate, RateCalendarUnit } from "../api/types";
import { ErrorLine } from "../lib/action";
import { addDays, dayNum, diffDays, isWeekend, longDate, monthName, weekdayShort } from "../lib/dates";
import { EMPTY_SELECTION, isNightTaken, nightState, tapDay, type DaySelection } from "../lib/derive";
import { eur } from "../lib/money";
import { useToast } from "../lib/toasts";
import type { RangeSelection } from "./PricePanel";

export function Weeks(props: {
  domains: DomainData[];
  rates: Map<number, RateCalendarUnit[]>;
  firstMonday: IsoDate;
  weeks: number;
  today: IsoDate;
  onOpenBooking: (id: number) => void;
  onSell: (s: { unitId: number; checkin: IsoDate; checkout: IsoDate }) => void;
  onPrice: (s: RangeSelection) => void;
}) {
  const { t } = useLingui();
  const toast = useToast();
  const refresh = useRefresh();
  const [sel, setSel] = useState<DaySelection>(EMPTY_SELECTION);
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = sel.first == null ? 1 : sel.departure == null ? 2 : 3;

  const domainOf = (unitId: number) => props.domains.find((d) => d.units.some((u) => u.id === unitId));
  const taken = (unitId: number, night: IsoDate) => {
    const pl = domainOf(unitId)?.planning;
    return pl ? isNightTaken({ bookings: pl.bookings, blocks: pl.blocks, manualBlocks: pl.manualBlocks }, unitId, night) : false;
  };

  function tap(unitId: number, unitName: string, day: IsoDate) {
    const r = tapDay(sel, unitId, day, { today: props.today, taken, unitName, label: longDate });
    setError(null);
    setBlocking(false);
    if (!r.ok) {
      toast(r.error, true);
      return;
    }
    setSel(r.selection);
  }

  const reset = () => {
    setSel(EMPTY_SELECTION);
    setBlocking(false);
    setReason("");
    setError(null);
  };

  function sheet(unitId: number) {
    if (sel.unitId !== unitId || !sel.first || !sel.departure) return null;
    const dm = domainOf(unitId);
    const u = dm?.units.find((x) => x.id === unitId);
    const nights = diffDays(sel.first, sel.departure);
    const days = props.rates.get(dm?.property.id ?? 0)?.find((r) => r.unit.id === unitId)?.days.filter((d) => d.date >= (sel.first as string) && d.date < (sel.departure as string)) ?? [];
    const sum = days.reduce((s, d) => s + (d.priceCents ?? 0), 0);
    const firstDay = days[0];
    const linked = dm?.links.filter((l) => l.blocksUnitId === unitId || l.unitId === unitId) ?? [];
    const other = u?.isComposite ? null : dm?.units.find((x) => x.isComposite && linked.some((l) => l.unitId === x.id || l.blocksUnitId === x.id));
    const range: RangeSelection = { propertyId: dm?.property.id ?? 0, unitId, from: sel.first, to: addDays(sel.departure, -1) };
    return (
      <div className="sheet" role="dialog" aria-labelledby="sh-h">
        <h2 id="sh-h">{u?.name}</h2>
        <p className="lead" style={{ margin: "4px 0 12px" }}>
          {t`Du ${longDate(sel.first)} au ${longDate(sel.departure)}, ${nights > 1 ? t`${nights} nuits` : t`1 nuit`}`}
        </p>
        {other ? (
          <p className="muted" style={{ display: "flex", gap: 8 }}>
            <IconLock size={20} />
            {t`${other.name} sera fermé ces nuits-là.`}
          </p>
        ) : null}
        <button type="button" className="choice main" onClick={() => props.onSell({ unitId, checkin: sel.first as string, checkout: sel.departure as string })}>
          <IconTag size={28} />
          <span>
            <b>
              <Trans>Vendre ces nuits</Trans>
            </b>
            <small>
              {sum > 0 ? t`${nights > 1 ? t`${nights} nuits` : t`1 nuit`} : ${eur(sum)} hors ménage. Le prix complet se calcule à l'étape suivante.` : t`Le prix se calcule à l'étape suivante.`}
              {firstDay?.minNights && nights < firstDay.minNights ? ` ${t`Attention : au moins ${firstDay.minNights} nuits à cette période.`}` : ""}
            </small>
          </span>
        </button>
        <button type="button" className="choice" aria-expanded={blocking} onClick={() => setBlocking((b) => !b)}>
          <IconLock size={28} />
          <span>
            <b>
              <Trans>Bloquer ces nuits</Trans>
            </b>
            <small>
              <Trans>Pour la famille, des travaux ou une autre raison.</Trans>
            </small>
          </span>
        </button>
        {blocking ? (
          <div style={{ marginBottom: 12 }}>
            <TextInput size="md" label={t`Pourquoi ?`} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
            <button
              type="button"
              className="btn pri wide"
              style={{ marginTop: 8 }}
              disabled={busy || reason.trim().length < 2}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api("/blocks", { method: "POST", body: { unitId, checkin: sel.first, checkout: sel.departure, reason: reason.trim() } });
                  await refresh();
                  toast(t`C'est fait. Nuits bloquées : ${reason.trim()}.`);
                  reset();
                } catch (e) {
                  setError(errorText(e));
                  toast(errorText(e), true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t`Un instant…` : t`Bloquer ${nights > 1 ? t`${nights} nuits` : t`la nuit`}`}
            </button>
          </div>
        ) : null}
        <button type="button" className="choice" onClick={() => props.onPrice(range)}>
          <IconCurrencyEuro size={28} />
          <span>
            <b>
              <Trans>Changer le prix</Trans>
            </b>
            <small>{firstDay?.priceCents != null ? t`Prix actuel : ${eur(firstDay.priceCents)} la nuit${firstDay.minNights ? t`, au moins ${firstDay.minNights} nuits` : ""}.` : t`Fixer un prix ou augmenter de 10 %.`}</small>
          </span>
        </button>
        {error ? <ErrorLine text={error} /> : null}
        <button type="button" className="btn ghost" onClick={reset}>
          <Trans>Recommencer</Trans>
        </button>
      </div>
    );
  }

  const weeks = Array.from({ length: props.weeks }, (_, i) => addDays(props.firstMonday, 7 * i));
  return (
    <div>
      <ol className="steps" aria-label={t`Étapes`}>
        {[t`Le premier jour`, t`Le jour de départ`, t`Que faire ?`].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? "step" : undefined} className={step > i + 1 ? "ok" : ""}>
            <b>{step > i + 1 ? <IconCheck size={16} /> : i + 1}</b>
            {label}
          </li>
        ))}
      </ol>
      {weeks.map((s) => {
        const e = addDays(s, 6);
        const title = s <= props.today && props.today <= e ? t`Cette semaine` : t`Semaine du ${dayNum(s)}${monthName(s) !== monthName(e) ? ` ${monthName(s)}` : ""} au ${dayNum(e) === 1 ? "1er" : dayNum(e)} ${monthName(e)}`;
        return (
          <section className="wk" key={s} aria-label={title}>
            <h2>{title}</h2>
            {props.domains.map((dm) =>
              dm.planning
                ? dm.units.map((u) => {
                    const pl = dm.planning!;
                    const occ = { bookings: pl.bookings, blocks: pl.blocks, manualBlocks: pl.manualBlocks };
                    const free = Array.from({ length: 7 }, (_, i) => addDays(s, i)).filter((d) => d >= props.today && !isNightTaken(occ, u.id, d)).length;
                    const lines = pl.bookings.filter((b) => b.unitId === u.id && b.checkout > s && b.checkin <= e);
                    const blocks = pl.manualBlocks.filter((k) => k.unitId === u.id && k.checkout > s && k.checkin <= e);
                    return (
                      <Fragment key={u.id}>
                        <div className="bien">
                          <div className="nm">
                            <span>{u.name}</span>
                            <small>{free ? (free > 1 ? t`${free} nuits libres` : t`1 nuit libre`) : t`complet`}</small>
                          </div>
                          <div className="days">
                            {Array.from({ length: 7 }, (_, i) => {
                              const d = addDays(s, i);
                              const st = nightState(occ, u.id, d);
                              const isSel = sel.unitId === u.id && sel.first != null && d >= sel.first && d <= (sel.departure ?? sel.first);
                              const edge = isSel && (d === sel.first || d === sel.departure);
                              return (
                                <button
                                  key={d}
                                  type="button"
                                  className={`d${st ? ` c-${st}` : ""}${isWeekend(d) ? " we" : ""}${d === props.today ? " today" : ""}${d < props.today ? " past" : ""}${isSel ? " sel" : ""}${edge ? " edge" : ""}`}
                                  aria-label={t`${u.name}, ${longDate(d)}${st ? t`, pris` : t`, libre`}`}
                                  aria-current={d === props.today ? "date" : undefined}
                                  aria-pressed={isSel}
                                  onClick={() => tap(u.id, u.name, d)}
                                >
                                  <small>{weekdayShort(d)}</small>
                                  {dayNum(d)}
                                </button>
                              );
                            })}
                          </div>
                          {lines.length || blocks.length ? (
                            <ul>
                              {lines.map((b) => (
                                <li key={b.id}>
                                  <button type="button" onClick={() => props.onOpenBooking(b.id)}>
                                    {weekdayShort(b.checkin)} {dayNum(b.checkin)} → {weekdayShort(b.checkout)} {dayNum(b.checkout)} : {b.guestName}
                                    {b.persons ? t`, ${b.persons} pers.` : ""}
                                    {b.status === "pending" ? t`, option` : b.balanceCents > 0 ? t`, ${eur(b.balanceCents)} à encaisser` : ""}
                                  </button>
                                </li>
                              ))}
                              {blocks.map((k) => (
                                <li key={`k${k.id}`}>
                                  {weekdayShort(k.checkin)} {dayNum(k.checkin)} → {weekdayShort(k.checkout)} {dayNum(k.checkout)} : {t`bloqué`}
                                  {k.reason ? `, ${k.reason}` : ""}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                        {sel.departure && sel.unitId === u.id && sel.first && sel.first >= s && sel.first <= e ? sheet(u.id) : null}
                      </Fragment>
                    );
                  })
                : null,
            )}
          </section>
        );
      })}
      <div className="wlegend" aria-label={t`Légende`}>
        <span>
          <i style={{ background: "var(--pine)", borderColor: "var(--pine)" }} />
          {t`Réservé et payé`}
        </span>
        <span>
          <i style={{ background: "var(--myrt-soft)", borderColor: "var(--myrt)" }} />
          {t`Solde à encaisser`}
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(-45deg,var(--genet-soft) 0 4px,var(--genet-mid) 4px 7px)", borderColor: "var(--genet)" }} />
          {t`Option, pas encore payée`}
        </span>
        <span>
          <i style={{ background: "var(--ourthe)", borderColor: "var(--ourthe)" }} />
          {t`Airbnb, Booking ou autre site`}
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(-45deg,var(--surface-2) 0 4px,var(--hatch) 4px 7px)" }} />
          {t`Bloqué`}
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(-45deg,transparent 0 4px,var(--line-2) 4px 7px)" }} />
          {t`Domaine : une des maisons est prise`}
        </span>
      </div>
    </div>
  );
}
