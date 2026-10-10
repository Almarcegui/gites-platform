// Ménage (plan v4, fonction 1) : un ménage par départ, avec l'heure, la
// prochaine arrivée et le nombre de voyageurs. PILOTE : « fait » est gardé
// sur cet appareil seulement.
import { Trans, useLingui } from "@lingui/react/macro";

import { useDomains } from "../api/hooks";
import { useCleaningDone } from "../lib/cleaning";
import { addDays, hourLabel, longDate, titleDate, todayBrussels } from "../lib/dates";
import { cleaningTasks, type CleaningTask } from "../lib/derive";
import { ErrorLine } from "../lib/action";

const HORIZON = 21;

export function CleaningPage() {
  const { t } = useLingui();
  const today = todayBrussels();
  const { domains, isLoading, error } = useDomains(addDays(today, -1), addDays(today, HORIZON + 60));
  const { isDone, toggle } = useCleaningDone();
  const data = domains
    .filter((d) => d.planning)
    .map((d) => ({
      propertyId: d.property.id,
      bookings: d.planning!.bookings,
      links: d.links,
      unitNames: new Map(d.units.map((u) => [u.id, u.name])),
      checkinTime: d.settings?.checkinTime ?? "16:00",
      checkoutTime: d.settings?.checkoutTime ?? "10:00",
    }));
  const tasks = cleaningTasks(data, today, HORIZON);
  const byDay = new Map<string, CleaningTask[]>();
  for (const k of tasks) byDay.set(k.date, [...(byDay.get(k.date) ?? []), k]);

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="head">
        <h1 className="title">
          <Trans>Ménage</Trans>
        </h1>
        <span className="pilot">{t`Pilote : « fait » est noté sur cet appareil seulement`}</span>
      </div>
      <p className="lead">{t`Chaque départ crée un ménage. La liste se met à jour toute seule, sur les trois prochaines semaines.`}</p>
      {error ? <ErrorLine text={t`La liste n'a pas pu être lue. Rechargez la page.`} /> : null}
      {isLoading && tasks.length === 0 ? <p className="loading">{t`Chargement…`}</p> : null}
      {!isLoading && tasks.length === 0 ? (
        <div className="empty">
          <h3>{t`Aucun ménage prévu`}</h3>
          <p>{t`Aucun départ dans les trois prochaines semaines.`}</p>
        </div>
      ) : null}
      {[...byDay].map(([day, list]) => (
        <section key={day} aria-label={longDate(day)}>
          <h2 className="mday">{day === today ? t`Aujourd'hui, ${longDate(day)}` : titleDate(day)}</h2>
          {list.map((c) => {
            const done = isDone(c.key);
            return (
              <article className="job" key={c.key}>
                <h3>{c.isComposite ? t`Les deux maisons, après le Domaine` : c.unitName}</h3>
                <dl className="when">
                  <dt>{t`Départ`}</dt>
                  <dd>{hourLabel(c.time)}</dd>
                  {c.next ? (
                    c.tight ? (
                      <>
                        <dt>{t`À finir avant`}</dt>
                        <dd className="tight">{t`${hourLabel(c.next.checkinTime)}, nouveaux voyageurs le jour même`}</dd>
                      </>
                    ) : (
                      <>
                        <dt>{t`Prochaine arrivée`}</dt>
                        <dd>
                          {longDate(c.next.checkin)}
                          {c.next.unitName && c.next.unitName !== c.unitName ? `, ${c.next.unitName}` : ""}
                        </dd>
                      </>
                    )
                  ) : (
                    <>
                      <dt>{t`Prochaine arrivée`}</dt>
                      <dd>{t`aucune de prévue`}</dd>
                    </>
                  )}
                  {c.next ? (
                    <>
                      <dt>{t`Pour`}</dt>
                      <dd>{t`${c.next.persons} personnes`}</dd>
                    </>
                  ) : null}
                </dl>
                <button type="button" className="tick" role="checkbox" aria-checked={done} onClick={() => toggle(c.key)}>
                  <span className="box">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                  </span>
                  <span>
                    {t`Ménage fait`}
                    <small>{done ? t`noté sur cet appareil` : t`touchez quand la maison est prête`}</small>
                  </span>
                </button>
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}
