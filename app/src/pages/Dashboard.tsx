// Tableau de bord de l'ordinateur (retour de Julien du 10/10 : « beaucoup
// moins d'information que sur le précédent »). Tout ce que montrait l'ancien
// tableau de bord, au même niveau : les 4 chiffres du mois (occupation et
// revenus comparés à l'an passé, prochaine arrivée, soldes à encaisser), les
// arrivées et départs des 7 jours, les alertes et la santé du système.
// Données : GET /api/admin/overview, un appel par domaine affiché.
import { useLingui } from "@lingui/react/macro";
import { IconArrowRight, IconArrowLeft } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";

import type { Overview } from "../api/types";
import { longDate, shortDate, todayBrussels, weekdayShort } from "../lib/dates";
import { eur } from "../lib/money";
import { useOpenBooking } from "../shell/Shell";
import { stayPhase } from "../../../src/core/stay-phase";

const fr1 = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");

/** Les 4 chiffres du mois. Plusieurs domaines : sommes pour l'argent, un
 *  pourcentage par domaine pour l'occupation (elle ne s'additionne pas). */
export function MonthKpis({ overviews }: { overviews: Overview[] }) {
  const { t, i18n } = useLingui();
  if (!overviews.length) return null;
  const many = overviews.length > 1;
  const month = new Date(`${overviews[0]!.today}T12:00:00Z`).toLocaleDateString(i18n.locale === "nl" ? "nl-BE" : "fr-BE", { month: "long" });
  const rev = overviews.reduce((s, o) => s + (o.kpis.revenueCents ?? 0), 0);
  const revPrev = overviews.reduce((s, o) => s + (o.kpis.revenuePrevCents ?? 0), 0);
  const revDelta = revPrev > 0 ? Math.round(((rev - revPrev) / revPrev) * 100) : null;
  const due = overviews.reduce((s, o) => s + o.kpis.balanceDueTotalCents, 0);
  const dueCount = overviews.reduce((s, o) => s + o.kpis.balanceDueCount, 0);
  const next = overviews
    .map((o) => o.kpis.nextArrival)
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => (a.checkin < b.checkin ? -1 : 1))[0];
  const occ = (o: Overview) => {
    const cur = o.kpis.occupancyPct ?? 0;
    const d = Math.round((cur - (o.kpis.occupancyPrevPct ?? 0)) * 10) / 10;
    return { cur, d };
  };
  return (
    <div className="kpis kpis-month" aria-label={t`Le mois en chiffres`}>
      <div className="kpi">
        <span>{t`Occupation, ${month}`}</span>
        {many ? (
          <div className="kpi-rows">
            {overviews.map((o) => {
              const x = occ(o);
              return (
                <p key={o.property.id}>
                  <span>{o.property.name.replace(/^(Les Gîtes du |Le )/, "")}</span> <b>{fr1(x.cur)} %</b>
                  <small className={x.d >= 0 ? "up" : "down"}>{x.d >= 0 ? `+${fr1(x.d)}` : fr1(x.d)} pts</small>
                </p>
              );
            })}
          </div>
        ) : (
          <>
            <b>{fr1(occ(overviews[0]!).cur)} %</b>
            <small className={occ(overviews[0]!).d >= 0 ? "up" : "down"}>{t`${occ(overviews[0]!).d >= 0 ? "+" : ""}${fr1(occ(overviews[0]!).d)} points par rapport à l'an passé`}</small>
          </>
        )}
      </div>
      <div className="kpi">
        <span>{t`Revenus, ${month}`}</span>
        <b>{eur(rev)}</b>
        <small className={revDelta == null ? "" : revDelta >= 0 ? "up" : "down"}>
          {revDelta == null ? t`pas de chiffre l'an passé` : t`${revDelta >= 0 ? "+" : ""}${revDelta} % par rapport à l'an passé (${eur(revPrev)})`}
        </small>
      </div>
      <div className="kpi">
        <span>{t`Prochaine arrivée`}</span>
        <b>{next ? `${weekdayShort(next.checkin)} ${shortDate(next.checkin)}` : "—"}</b>
        <small>{next ? t`${next.unitName}, ${next.persons} pers.${next.guestName ? `, ${next.guestName}` : ""}` : t`aucune réservation à venir`}</small>
      </div>
      <div className="kpi">
        <span>{t`À encaisser (soldes)`}</span>
        <b>{eur(due)}</b>
        <small>{dueCount > 0 ? (dueCount > 1 ? t`${dueCount} dossiers` : t`1 dossier`) : t`à jour`}</small>
      </div>
    </div>
  );
}

/** Arrivées et départs des 7 jours, une ligne par mouvement. */
export function WeekMovements({ overviews }: { overviews: Overview[] }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  const today = todayBrussels();
  const many = overviews.length > 1;
  const rows = overviews
    .flatMap((o) => (o.movements ?? []).map((m) => ({ ...m, property: o.property.name })))
    .sort((a, b) => ((a.kind === "arrivée" ? a.checkin : a.checkout) < (b.kind === "arrivée" ? b.checkin : b.checkout) ? -1 : 1));
  const phaseText = (m: (typeof rows)[number]) => {
    const p = stayPhase(m, today, m.kind === "arrivée" ? "arrival" : "departure");
    return p === "arrive-today" ? t`arrive aujourd'hui` : p === "arrive-tomorrow" ? t`arrive demain` : p === "leaves-today" ? t`part aujourd'hui` : "";
  };
  return (
    <section className="dash-card" aria-labelledby="h-week">
      <h2 className="sub" id="h-week">{t`Arrivées et départs, 7 jours`}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t`Aucun mouvement cette semaine.`}</p>
      ) : (
        <table className="tbl dense">
          <thead>
            <tr>
              <th scope="col">{t`Mouvement`}</th>
              <th scope="col">{t`Bien`}</th>
              <th scope="col">{t`Client`}</th>
              <th scope="col" className="r">
                {t`Pers.`}
              </th>
              <th scope="col">{t`Statut`}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={`${m.kind}${m.id}`} className="row-link" tabIndex={0} onClick={() => openBooking(m.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openBooking(m.id))}>
                <td>
                  {m.kind === "arrivée" ? <IconArrowRight size={16} aria-label={t`arrivée`} /> : <IconArrowLeft size={16} aria-label={t`départ`} />}{" "}
                  {weekdayShort(m.kind === "arrivée" ? m.checkin : m.checkout)} {shortDate(m.kind === "arrivée" ? m.checkin : m.checkout)}
                </td>
                <td>
                  {m.unitName}
                  {many ? <small>{m.property}</small> : null}
                </td>
                <td>{m.guestName || "—"}</td>
                <td className="r">{m.persons}</td>
                <td>
                  {m.status === "pending" ? <span className="pill option">{t`option`}</span> : null} {phaseText(m)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Alertes : soldes en retard, liaisons actives, flux iCal, options en cours, messages. */
export function AlertsCard({ overviews }: { overviews: Overview[] }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  const navigate = useNavigate();
  const many = overviews.length > 1;
  const rows: { key: string; kind: string; text: string; go: () => void }[] = [];
  for (const o of overviews) {
    const where = many ? `${o.property.name} : ` : "";
    for (const b of o.alerts.overdueBalances)
      rows.push({ key: `o${b.id}`, kind: t`Solde en retard`, text: `${where}${b.guestName || b.reference}, ${eur(b.balanceCents)}${b.balanceDueDate ? t` (échéance ${longDate(b.balanceDueDate)})` : ""}`, go: () => openBooking(b.id) });
    for (const l of o.alerts.linkAlerts ?? [])
      rows.push({ key: `l${l.id}`, kind: t`Liaison active`, text: t`${where}${l.unitName} du ${shortDate(l.checkin)} au ${shortDate(l.checkout)} : ${l.blocked.join(" et ")} bloqué(s)`, go: () => openBooking(l.id) });
    for (const f of o.alerts.feedAlerts ?? [])
      rows.push({ key: `f${o.property.id}-${f.id}`, kind: t`Flux iCal`, text: `${where}${f.name} : ${f.status ?? ""}`, go: () => void navigate({ to: "/reglages/calendriers" }) });
    for (const h of o.alerts.activeHolds)
      rows.push({ key: `h${h.id}`, kind: t`Option en cours`, text: t`${where}${h.reference}, ${h.unitName}${h.holdExpiresAt ? t` (expire le ${longDate(h.holdExpiresAt.slice(0, 10))} à ${h.holdExpiresAt.slice(11, 16)} UTC)` : ""}`, go: () => openBooking(h.id) });
    if (o.alerts.newEmails > 0) rows.push({ key: `m${o.property.id}`, kind: t`Messages`, text: t`${where}${o.alerts.newEmails} message(s) client à traiter`, go: () => void navigate({ to: "/messages" }) });
  }
  return (
    <section className="dash-card" aria-labelledby="h-alerts">
      <h2 className="sub" id="h-alerts">{t`Alertes`}</h2>
      {rows.length === 0 ? (
        <p className="muted">{t`Rien à signaler.`}</p>
      ) : (
        <table className="tbl dense">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="row-link" tabIndex={0} onClick={r.go} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), r.go())}>
                <td className="nowrap">
                  <b>{r.kind}</b>
                </td>
                <td>{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
