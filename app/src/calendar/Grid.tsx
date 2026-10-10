// Calendrier multi-biens (maquette A) : une ligne par bien, les barres sciées
// en biais, le trait jaune du jour, la ligne prix et minimum sous chaque bien.
// Toucher une case (ou glisser sur une plage) ouvre le popover.
import { useLingui } from "@lingui/react/macro";
import { IconBrush, IconCurrencyEuro, IconLock } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DomainData } from "../api/hooks";
import type { IsoDate, PlanningBooking, RateCalendarUnit, Unit } from "../api/types";
import { addDays, dayNum, dayRange, isWeekend, longDate, monthShort, shortDate, weekdayShort } from "../lib/dates";
import { BAR_LABEL, barColumns, barKind, channelName, isChannel, isNightTaken } from "../lib/derive";
import type { RangeSelection } from "./PricePanel";

export interface GridProps {
  domains: DomainData[];
  rates: Map<number, RateCalendarUnit[]>;
  start: IsoDate;
  days: number;
  today: IsoDate;
  showPrices: boolean;
  selection: RangeSelection | null;
  onOpenBooking: (id: number) => void;
  onSelect: (s: RangeSelection, anchor: DOMRect | null) => void;
}

interface Span {
  checkin: IsoDate;
  checkout: IsoDate;
  label: string;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.checkin <= last.checkout) {
      if (s.checkout > last.checkout) last.checkout = s.checkout;
      if (last.label !== s.label) last.label = "Une maison est prise";
    } else out.push({ ...s });
  }
  return out;
}

function guestLabel(b: PlanningBooking): string {
  const name = b.guestName && b.guestName !== "—" ? b.guestName.trim().split(/\s+/).slice(-1)[0] ?? b.guestName : "";
  return name || (isChannel(b) ? "Réservé ailleurs" : b.reference);
}

export function Grid(props: GridProps) {
  const { t } = useLingui();
  const { start, days, today, selection } = props;
  const dates = dayRange(start, days);
  const drag = useRef<{ propertyId: number; unitId: number; anchor: IsoDate } | null>(null);
  const [hover, setHoverState] = useState<RangeSelection | null>(null);
  const hoverRef = useRef<RangeSelection | null>(null);
  const setHover = (h: RangeSelection | null) => {
    hoverRef.current = h;
    setHoverState(h);
  };
  const shown = hover ?? selection;

  const inSel = (unitId: number, d: IsoDate) => !!shown && shown.unitId === unitId && d >= shown.from && d <= shown.to;

  function begin(propertyId: number, unitId: number, d: IsoDate) {
    drag.current = { propertyId, unitId, anchor: d };
    setHover({ propertyId, unitId, from: d, to: d });
  }
  function extend(unitId: number, d: IsoDate) {
    const g = drag.current;
    if (!g || g.unitId !== unitId) return;
    setHover({ propertyId: g.propertyId, unitId, from: d < g.anchor ? d : g.anchor, to: d < g.anchor ? g.anchor : d });
  }
  function finish(el: HTMLElement | null) {
    const g = drag.current;
    drag.current = null;
    const s = hoverRef.current;
    if (!g || !s) return;
    setHover(null);
    props.onSelect(s, el?.getBoundingClientRect() ?? null);
  }
  // Relâché hors de la grille : la plage parcourue reste choisie.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const up = () => {
      if (!drag.current) return;
      const s = hoverRef.current;
      const cell = s ? document.querySelector<HTMLElement>(`.pc[data-unit="${s.unitId}"][data-date="${s.to}"]`) : null;
      finishRef.current(cell);
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const cellHandlers = (propertyId: number, unitId: number, d: IsoDate) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      begin(propertyId, unitId, d);
    },
    onPointerEnter: () => extend(unitId, d),
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => finish(e.currentTarget as HTMLElement),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      // Maj + Entrée prolonge la plage déjà choisie sur ce bien.
      if (e.shiftKey && selection && selection.unitId === unitId) {
        const from = d < selection.from ? d : selection.from;
        const to = d > selection.to ? d : selection.to;
        props.onSelect({ propertyId, unitId, from, to }, e.currentTarget.getBoundingClientRect());
      } else props.onSelect({ propertyId, unitId, from: d, to: d }, e.currentTarget.getBoundingClientRect());
    },
  });

  const bgs = (propertyId: number, unitId: number) =>
    dates.map((d, i) => (
      <div
        key={d}
        className={`bg${isWeekend(d) ? " we" : ""}${d === today ? " now" : ""}${inSel(unitId, d) ? " sel" : ""}`}
        style={{ gridColumn: `${2 + 2 * i} / span 2` }}
        {...cellHandlers(propertyId, unitId, d)}
        onKeyDown={undefined}
      />
    ));

  const bar = (key: string, checkin: IsoDate, checkout: IsoDate, cls: string, inner: ReactNode, label: string, onClick?: () => void) => {
    const c = barColumns(start, days, checkin, checkout);
    if (!c) return null;
    const style = { gridColumn: `${c.from} / ${c.to}` };
    const className = `bar ${cls}${c.flatL ? " flatL" : ""}${c.flatR ? " flatR" : ""}`;
    return onClick ? (
      <button key={key} type="button" className={className} style={style} title={label} aria-label={label} onClick={onClick}>
        {inner}
      </button>
    ) : (
      <div key={key} className={className} style={style} title={label} aria-label={label} role="img">
        {inner}
      </div>
    );
  };

  function unitRow(domain: DomainData, u: Unit) {
    const pl = domain.planning;
    if (!pl) return null;
    const own = pl.bookings.filter((b) => b.unitId === u.id);
    const linkSpans = pl.blocks.filter((k) => k.unitId === u.id);
    const fromComposite = linkSpans.filter((k) => pl.bookings.find((b) => b.id === k.sourceBookingId)?.isComposite);
    const otherLinks = linkSpans.filter((k) => !fromComposite.includes(k));
    const unitName = (id: number) => domain.units.find((x) => x.id === id)?.name ?? "";
    const pris = mergeSpans(
      otherLinks.map((k) => {
        const src = pl.bookings.find((b) => b.id === k.sourceBookingId);
        const manual = k.sourceBookingId === 0;
        const n = src ? unitName(src.unitId) : "";
        return { checkin: k.checkin, checkout: k.checkout, label: manual ? t`Bloqué par une maison` : n ? t`${n} est pris` : t`Une maison est prise` };
      }),
    );
    const departing = own.some((b) => b.checkout === today) || fromComposite.some((k) => k.checkout === today);
    const todayIdx = dates.indexOf(today);
    const rates = props.rates.get(domain.property.id)?.find((r) => r.unit.id === u.id);
    const occupancy = { bookings: pl.bookings, blocks: pl.blocks, manualBlocks: pl.manualBlocks };
    return (
      <div key={u.id} role="rowgroup" aria-label={u.name}>
        <div className="row" data-unit={u.id}>
          <div className="lab">
            <b>{u.name}</b>
            <small>{u.isComposite ? t`les deux maisons` : t`${u.capacityMax} pers.`}</small>
          </div>
          {bgs(domain.property.id, u.id)}
          {pris.map((s, i) => bar(`p${i}`, s.checkin, s.checkout, "pris", <span>{s.label}</span>, t`${u.name} indisponible ${shortDate(s.checkin)} – ${shortDate(s.checkout)} : ${s.label}`))}
          {fromComposite.map((k) => {
            const src = pl.bookings.find((b) => b.id === k.sourceBookingId) as PlanningBooking;
            const kind = barKind(src);
            return bar(`d${k.sourceBookingId}`, k.checkin, k.checkout, `${kind} dref`, <span>{t`Domaine, ${guestLabel(src)}`}</span>, t`${unitName(src.unitId)}, ${src.guestName}, ${shortDate(src.checkin)} – ${shortDate(src.checkout)}, ${BAR_LABEL[kind]}`, () => props.onOpenBooking(src.id));
          })}
          {own.map((b) => {
            const kind = barKind(b);
            const icon = kind === "solde" ? <IconCurrencyEuro size={16} /> : null;
            return bar(
              `b${b.id}`,
              b.checkin,
              b.checkout,
              kind,
              <>
                {icon}
                <span>
                  {guestLabel(b)}
                  {kind === "plat" ? <i> {channelName(b)}</i> : null}
                </span>
              </>,
              t`${b.guestName}, ${u.name}, du ${shortDate(b.checkin)} au ${shortDate(b.checkout)}, ${kind === "plat" ? t`via ${channelName(b)}` : BAR_LABEL[kind]}`,
              () => props.onOpenBooking(b.id),
            );
          })}
          {pl.manualBlocks
            .filter((k) => k.unitId === u.id)
            .map((k) =>
              bar(
                `m${k.id}`,
                k.checkin,
                k.checkout,
                "bloc",
                <>
                  <IconLock size={16} />
                  <span>{k.reason || t`Bloqué`}</span>
                </>,
                t`Bloqué du ${shortDate(k.checkin)} au ${shortDate(k.checkout)} : ${k.reason ?? ""}`,
              ),
            )}
          {departing && todayIdx >= 0 ? (
            <span className="mk" style={{ gridColumn: `${2 + 2 * todayIdx} / span 2` }} title={t`Ménage à faire aujourd'hui`}>
              <IconBrush size={13} />
            </span>
          ) : null}
        </div>
        {props.showPrices ? (
          <div className="row px">
            <div className="lab">{t`Prix, minimum`}</div>
            {dates.map((d, i) => {
              const r = rates?.days.find((x) => x.date === d);
              const taken = isNightTaken(occupancy, u.id, d);
              const price = r?.priceCents != null ? Math.round(r.priceCents / 100) : null;
              const cls = `pc${taken ? " occ" : ""}${r?.holidayRated ? " fer" : ""}${r?.overridePriceCents != null ? " man" : ""}${isWeekend(d) ? " we" : ""}${inSel(u.id, d) ? " sel" : ""}`;
              return (
                <button
                  key={d}
                  type="button"
                  className={cls}
                  style={{ gridColumn: `${2 + 2 * i} / span 2` }}
                  data-date={d}
                  data-unit={u.id}
                  aria-label={t`${u.name}, ${longDate(d)} : ${price != null ? t`${price} € la nuit` : t`pas de prix`}${r?.minNights ? t`, au moins ${r.minNights} nuits` : ""}${taken ? t`, déjà pris` : ""}`}
                  {...cellHandlers(domain.property.id, u.id, d)}
                >
                  <b>{price ?? "—"}</b>
                  <small>{r?.minNights ? t`${r.minNights} n.` : ""}</small>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid" style={{ ["--n2" as string]: String(days * 2) }}>
      <div className="row hd">
        <div className="lab">{days <= 14 ? t`${days} jours` : `${monthShort(start)} – ${monthShort(addDays(start, days - 1))}`}</div>
        {dates.map((d, i) => (
          <div key={d} className={`dh${isWeekend(d) ? " we" : ""}${d === today ? " now" : ""}`} style={{ gridColumn: `${2 + 2 * i} / span 2` }} aria-current={d === today ? "date" : undefined}>
            {i === 0 || dayNum(d) === 1 ? <span className="mo">{monthShort(d)}</span> : weekdayShort(d)}
            <b>{dayNum(d)}</b>
          </div>
        ))}
      </div>
      {props.domains.map((dm) => (
        <div key={dm.property.id} role="rowgroup" aria-label={dm.property.name}>
          <div className="row grp">
            <div className="lab">
              {dm.property.name} <small>{dm.property.commune ?? ""}</small>
            </div>
          </div>
          {dm.planning ? dm.units.map((u) => unitRow(dm, u)) : null}
        </div>
      ))}
    </div>
  );
}

export function GridLegend() {
  const { t } = useLingui();
  return (
    <div className="legend" aria-label={t`Légende`}>
      <span>
        <i className="sw" style={{ background: "var(--pine)" }} />
        {t`Confirmée et payée`}
      </span>
      <span>
        <i className="sw" style={{ background: "var(--myrt)" }} />
        {t`Solde à encaisser`}
      </span>
      <span>
        <i className="sw" style={{ background: "repeating-linear-gradient(-45deg,var(--genet-soft) 0 4px,var(--genet-mid) 4px 7px)" }} />
        {t`Option, arrhes pas encore payées`}
      </span>
      <span>
        <i className="sw" style={{ background: "var(--ourthe)" }} />
        {t`Airbnb, Booking ou autre site`}
      </span>
      <span>
        <i className="sw" style={{ background: "repeating-linear-gradient(-45deg,var(--surface-2) 0 3px,var(--hatch) 3px 5px)" }} />
        {t`Bloqué`}
      </span>
      <span>{t`Prix souligné : changé à la main`}</span>
    </div>
  );
}

