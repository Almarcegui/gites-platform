// Chiffres de l'année : quatre chiffres comparés à l'an passé, le remplissage
// mois par mois, la part de chaque bien, les exports. Les indicateurs de
// décision (avance de réservation, abandons, dates cherchées) sont repliés.
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { StatsResponse } from "../../api/types2";
import { ErrorLine } from "../../lib/action";
import { stayRange, todayBrussels } from "../../lib/dates";
import { eur } from "../../lib/money";
import { useScope } from "../../lib/scope";
import { DownloadButton, Fold, Loading, Page, Section, useWorkingProperty } from "../../ui/kit";

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const fr = (n: number, d = 0) => n.toLocaleString("fr-BE", { minimumFractionDigits: d, maximumFractionDigits: d });

export function StatsPage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const { scope } = useScope();
  const pid = property?.id;
  const [year, setYear] = useState(Number(todayBrussels().slice(0, 4)));
  const q = useQuery({ queryKey: ["stats", pid, year], queryFn: () => api<StatsResponse>("/stats", { query: { property: pid, year } }), enabled: pid != null });
  const cur = q.data?.current;
  const prev = q.data?.previous;
  const cmp = (a: number, b: number | undefined, unit: string, d = 0) => {
    if (b == null || b === 0) return t`pas de chiffre en ${year - 1}`;
    const diff = a - b;
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
    return t`${sign} ${fr(Math.abs(diff), d)}${unit} par rapport à ${year - 1}`;
  };
  const pctChange = (a: number, b: number) => {
    const p = Math.round(((a - b) / b) * 100);
    return p === 0 ? t`comme en ${year - 1}` : t`${p > 0 ? "+" : "−"} ${fr(Math.abs(p))} % par rapport à ${year - 1}`;
  };
  const max = Math.max(10, ...(cur?.months.map((m) => m.occupancyPct) ?? []), ...(prev?.months.map((m) => m.occupancyPct) ?? []));
  return (
    <Page
      title={t`Chiffres ${year}`}
      back
      tools={
        <>
          {picker}
          <button type="button" className="btn" onClick={() => setYear(year - 1)}>
            {year - 1}
          </button>
          <button type="button" className="btn" onClick={() => setYear(year + 1)}>
            {year + 1}
          </button>
        </>
      }
      lead={property ? t`${property.name}. Seules les réservations confirmées comptent ; une réservation du Domaine entier occupe ses deux maisons.` : undefined}
    >
      {q.error ? <ErrorLine text={t`Les chiffres n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {cur && prev ? (
        <>
          <div className="kpis">
            <div className="kpi">
              <span>{t`Remplissage`}</span>
              <b>{fr(cur.occupancyPct, 1)} %</b>
              <small>{cmp(cur.occupancyPct, prev.occupancyPct || undefined, " points", 1)}</small>
            </div>
            <div className="kpi">
              <span>{t`Revenus`}</span>
              <b>{eur(cur.revenueCents)}</b>
              <small>{prev.revenueCents > 0 ? pctChange(cur.revenueCents, prev.revenueCents) : t`pas de chiffre en ${year - 1}`}</small>
            </div>
            <div className="kpi">
              <span>{t`Prix moyen d'une nuit`}</span>
              <b>{eur(cur.adrCents)}</b>
              <small>{cmp(Math.round(cur.adrCents / 100), prev.adrCents ? Math.round(prev.adrCents / 100) : undefined, " €")}</small>
            </div>
            <div className="kpi">
              <span>{t`Durée moyenne d'un séjour`}</span>
              <b>{t`${fr(cur.avgStayNights, 1)} nuits`}</b>
              <small>{cmp(cur.avgStayNights, prev.avgStayNights || undefined, " nuit", 1)}</small>
            </div>
          </div>

          <Section title={t`Remplissage mois par mois`} hint={t`Part des nuits occupées, en %. Le trait gris marque ${year - 1}.`}>
            <div className="mbars" role="img" aria-label={t`Remplissage par mois en ${year}, comparé à ${year - 1}`}>
              {cur.months.map((m, i) => {
                const p = prev.months[i]?.occupancyPct ?? 0;
                const tip = t`${MONTHS[i]} ${year} : ${fr(m.occupancyPct, 1)} % (${m.occupiedNights} nuits sur ${m.capacityNights}), ${eur(m.revenueCents)}. En ${year - 1} : ${fr(p, 1)} %.`;
                return (
                  <div key={m.month} className="mcol" title={tip}>
                    <b>{m.occupancyPct > 0 ? fr(m.occupancyPct) : ""}</b>
                    <div className="mtrack">
                      <i className="mbar" style={{ height: `${(m.occupancyPct / max) * 100}%` }} />
                      {p > 0 ? <i className="mprev" style={{ bottom: `${(p / max) * 100}%` }} /> : null}
                    </div>
                    <span>{MONTHS[i]}</span>
                  </div>
                );
              })}
            </div>
            <div className="ylegend">
              <span>
                <i className="lv3" />
                {year}
              </span>
              <span>
                <i className="prevline" />
                {year - 1}
              </span>
            </div>
            <Fold title={t`Les mêmes chiffres en tableau`}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t`Mois`}</th>
                    <th className="r">{t`Nuits occupées`}</th>
                    <th className="r">{t`Remplissage`}</th>
                    <th className="r">{t`Revenus`}</th>
                    <th className="r">{t`En ${year - 1}`}</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.months.map((m, i) => (
                    <tr key={m.month}>
                      <td>{MONTHS[i]}</td>
                      <td className="r">
                        {m.occupiedNights} / {m.capacityNights}
                      </td>
                      <td className="r">{fr(m.occupancyPct, 1)} %</td>
                      <td className="r">{eur(m.revenueCents)}</td>
                      <td className="r">{fr(prev.months[i]?.occupancyPct ?? 0, 1)} %</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Fold>
          </Section>

          <Section title={t`Par bien`}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t`Bien`}</th>
                  <th className="r">{t`Nuits vendues`}</th>
                  <th className="r">{t`Revenus`}</th>
                </tr>
              </thead>
              <tbody>
                {cur.perUnit.map((u) => (
                  <tr key={u.unitId}>
                    <td>{u.name}</td>
                    <td className="r">{u.nights}</td>
                    <td className="r">{eur(u.revenueCents)}</td>
                  </tr>
                ))}
                <tr className="tot">
                  <td>{cur.bookingsCount > 1 ? t`Total, ${cur.bookingsCount} réservations` : t`Total, ${cur.bookingsCount} réservation`}</td>
                  <td className="r">{cur.soldNights}</td>
                  <td className="r">{eur(cur.revenueCents)}</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <Section title={t`Exports`} hint={t`Fichiers à ouvrir dans un tableur.`}>
            <div className="acts">
              <DownloadButton path="/stats.csv" query={{ property: pid, year }} filename={`chiffres-${year}.csv`}>
                {t`Chiffres ${year}`}
              </DownloadButton>
              <DownloadButton path="/bookings.csv" query={{ property: scope === "all" ? undefined : scope }} filename="reservations.csv">
                {t`Toutes les réservations`}
              </DownloadButton>
            </div>
          </Section>

          {q.data?.leadTime && q.data.funnel && q.data.searches ? (
            <Section title={t`Pour décider`} hint={t`Trois lectures pour régler l'ouverture des calendriers et les prix.`}>
              <Fold title={t`À quelle avance on réserve`} count={q.data.leadTime.count ? t`${fr(q.data.leadTime.medianDays)} jours en médiane` : t`aucune réservation`}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t`Mois d'arrivée`}</th>
                      <th className="r">{t`Réservations`}</th>
                      <th className="r">{t`Avance moyenne`}</th>
                      <th className="r">{t`Avance médiane`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.leadTime.byMonth
                      .filter((m) => m.count > 0)
                      .map((m) => (
                        <tr key={m.key}>
                          <td>{m.label}</td>
                          <td className="r">{m.count}</td>
                          <td className="r">{t`${fr(m.avgDays, 1)} j`}</td>
                          <td className="r">{t`${fr(m.medianDays, 1)} j`}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Fold>
              <Fold title={t`Où les visiteurs du site s'arrêtent`}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t`Étape`}</th>
                      <th className="r">{t`Nombre`}</th>
                      <th className="r">{t`Passent à l'étape`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.funnel.steps.map((s) => (
                      <tr key={s.key} className={s.key === q.data!.funnel!.biggestDropKey ? "warn-row" : ""}>
                        <td>
                          {s.label}
                          {s.key === q.data!.funnel!.biggestDropKey ? t` (plus forte perte)` : ""}
                        </td>
                        <td className="r">{s.count}</td>
                        <td className="r">{s.fromPreviousPct == null ? "" : `${fr(s.fromPreviousPct, 1)} %`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Fold>
              <Fold title={t`Dates cherchées sans réponse`} count={String(q.data.searches.topEmpty.length)}>
                {q.data.searches.topEmpty.length === 0 ? (
                  <p className="muted">{t`Aucune recherche restée sans réponse.`}</p>
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{t`Séjour cherché`}</th>
                        <th className="r">{t`Personnes`}</th>
                        <th className="r">{t`Fois`}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.data.searches.topEmpty.map((g, i) => (
                        <tr key={i}>
                          <td>{stayRange(g.checkin, g.checkout)}</td>
                          <td className="r">{g.maxPersons}</td>
                          <td className="r">{g.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Fold>
            </Section>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
