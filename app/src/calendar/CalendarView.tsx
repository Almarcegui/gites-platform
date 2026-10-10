// Le calendrier tel qu'il s'affiche dans Aujourd'hui (A) et dans Calendrier :
// grille multi-biens à l'ordinateur, semaines empilées au téléphone (avec la
// grille de 14 jours en second choix). Mêmes données, même popover.
import { Trans, useLingui } from "@lingui/react/macro";
import { IconChevronLeft, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "../api/client";
import { useDomains } from "../api/hooks";
import type { ManualBlock, RateCalendarUnit } from "../api/types";
import { BlockPanel } from "./BlockPanel";
import { ErrorLine } from "../lib/action";
import { addDays, mondayOf, todayBrussels } from "../lib/dates";
import { useLayout } from "../lib/useLayout";
import { useSale } from "../sale/SaleFlow";
import { useOpenBooking } from "../shell/Shell";
import { Grid, GridLegend } from "./Grid";
import { PricePanel, type RangeSelection } from "./PricePanel";
import { Weeks } from "./Weeks";

function readPrices(): boolean {
  try {
    return localStorage.getItem("gp2_prix") !== "0";
  } catch {
    return true;
  }
}

export function CalendarView({ title, before }: { title: ReactNode; before?: ReactNode }) {
  const { t } = useLingui();
  const layout = useLayout();
  const today = todayBrussels();
  const openBooking = useOpenBooking();
  const sell = useSale();
  const [offset, setOffset] = useState(0);
  const [prices, setPrices] = useState(readPrices);
  const [phoneMode, setPhoneMode] = useState<"weeks" | "grid">("weeks");
  const [sel, setSel] = useState<RangeSelection | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const calRef = useRef<HTMLDivElement>(null);
  const [block, setBlock] = useState<ManualBlock | null>(null);

  const useGrid = layout === "A" || phoneMode === "grid";
  const days = layout === "A" ? 31 : 14;
  const start = layout === "A" ? addDays(today, -2 + offset) : addDays(today, offset);
  const firstMonday = mondayOf(addDays(today, offset));
  const weeksCount = 5;
  const from = useGrid ? addDays(start, -1) : addDays(firstMonday, -1);
  const to = useGrid ? addDays(start, days + 1) : addDays(firstMonday, 7 * weeksCount + 1);
  const { domains, isLoading, error } = useDomains(from, to);

  const rateQs = useQueries({
    queries: domains.map((d) => ({
      queryKey: ["rates", d.property.id, from, to],
      queryFn: () => api<{ units: RateCalendarUnit[] }>("/rate-calendar", { query: { property: d.property.id, from, to } }).then((r) => r.units),
    })),
  });
  const rates = useMemo(() => {
    const m = new Map<number, RateCalendarUnit[]>();
    domains.forEach((d, i) => {
      const data = rateQs[i]?.data;
      if (data) m.set(d.property.id, data);
    });
    return m;
  }, [domains, rateQs]);

  const selDomain = sel ? domains.find((d) => d.property.id === sel.propertyId) : undefined;
  const step = layout === "A" ? 14 : useGrid ? 7 : 7;

  return (
    <section aria-labelledby="h-cal">
      <div className="head">
        <h1 className="title" id="h-cal">
          {title}
        </h1>
        <div className="tools">
          {useGrid ? (
            <>
              <button type="button" className="btn icon" aria-label={t`Période précédente`} onClick={() => setOffset((o) => o - step)}>
                <IconChevronLeft size={22} />
              </button>
              <button type="button" className="btn" onClick={() => setOffset(0)} disabled={offset === 0}>
                <Trans>Aujourd'hui</Trans>
              </button>
              <button type="button" className="btn icon" aria-label={t`Période suivante`} onClick={() => setOffset((o) => o + step)}>
                <IconChevronRight size={22} />
              </button>
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={prices}
                onClick={() => {
                  setPrices((p) => {
                    try {
                      localStorage.setItem("gp2_prix", p ? "0" : "1");
                    } catch {
                      /* stockage indisponible */
                    }
                    return !p;
                  });
                }}
              >
                <i />
                <span>
                  <Trans>Prix et minimum</Trans>
                </span>
              </button>
            </>
          ) : null}
          {layout === "B" ? (
            <div className="seg" role="group" aria-label={t`Affichage du calendrier`} style={{ margin: 0, flex: "1 1 220px" }}>
              <button type="button" aria-pressed={phoneMode === "weeks"} onClick={() => setPhoneMode("weeks")}>
                <Trans>Semaines</Trans>
              </button>
              <button type="button" aria-pressed={phoneMode === "grid"} onClick={() => setPhoneMode("grid")}>
                <Trans>Grille 14 jours</Trans>
              </button>
            </div>
          ) : null}
          <button type="button" className="btn pri" onClick={() => sell()}>
            <IconPlus size={22} />
            <Trans>Nouvelle vente</Trans>
          </button>
        </div>
      </div>
      {before}
      {error ? <ErrorLine text={t`Le calendrier n'a pas pu être lu. Rechargez la page.`} /> : null}
      {rateQs.some((q) => q.isError) ? <ErrorLine text={t`Les prix n'ont pas pu être lus : ne les changez pas avant d'avoir rechargé la page.`} /> : null}
      {isLoading && domains.every((d) => !d.planning) ? <p className="loading">{t`Chargement du calendrier…`}</p> : null}
      {useGrid ? (
        <>
          <div className="cal" ref={calRef}>
            <Grid
              domains={domains}
              rates={rates}
              start={start}
              days={days}
              today={today}
              showPrices={prices}
              selection={sel}
              onOpenBooking={openBooking}
              onOpenBlock={setBlock}
              onSelect={(s, a) => {
                setSel(s);
                setAnchor(a);
              }}
            />
          </div>
          <GridLegend />
        </>
      ) : (
        <Weeks
          domains={domains}
          rates={rates}
          firstMonday={firstMonday}
          weeks={weeksCount}
          today={today}
          onOpenBooking={openBooking}
          onOpenBlock={setBlock}
          onSell={(s) => sell({ unitId: s.unitId, checkin: s.checkin, checkout: s.checkout })}
          onPrice={(s) => {
            setSel(s);
            setAnchor(null);
          }}
        />
      )}
      {sel && selDomain && !rateQs.some((q) => q.isError) ? (
        <PricePanel
          selection={sel}
          units={selDomain.units}
          rates={rates.get(sel.propertyId)}
          anchor={anchor}
          onClose={() => setSel(null)}
          onSell={(s) => {
            setSel(null);
            sell({ unitId: s.unitId, checkin: s.from, checkout: addDays(s.to, 1) });
          }}
        />
      ) : null}
      {block ? <BlockPanel block={block} unitName={domains.flatMap((d) => d.units).find((u) => u.id === block.unitId)?.name ?? ""} onClose={() => setBlock(null)} /> : null}
    </section>
  );
}
