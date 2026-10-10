// Aujourd'hui (plan v4, changement 1). À l'ordinateur (A) : le bandeau du jour
// au-dessus de la grille multi-biens. Au téléphone (B) : la phrase du jour et
// le fil horaire en cartes.
import { Trans, useLingui } from "@lingui/react/macro";
import { IconBrush, IconCurrencyEuro, IconDeviceMobileMessage, IconLock, IconLogin2, IconLogout2, IconMessage, IconPhone } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { api } from "../api/client";
import { useBooking, useDomains, useGuest, useMessages, useOverviews, type DomainData } from "../api/hooks";
import type { Message, OverviewBalance, PlanningBooking } from "../api/types";
import { CalendarView } from "../calendar/CalendarView";
import { ActionButton, ErrorLine } from "../lib/action";
import { useCleaningDone } from "../lib/cleaning";
import { addDays, hourLabel, longDate, stayRange, titleDate, todayBrussels, weekdayShort, dayNum } from "../lib/dates";
import { channelName, cleaningTasks, dayEvents, daySentence, isChannel, nombre, type CleaningTask, type DayEvent } from "../lib/derive";
import { eur } from "../lib/money";
import { useLayout } from "../lib/useLayout";
import { useOpenBooking } from "../shell/Shell";

function useDay() {
  const today = todayBrussels();
  const { domains, isLoading, error } = useDomains(addDays(today, -1), addDays(today, 45));
  const overviews = useOverviews();
  const messagesQ = useMessages("nouveau");
  const messages = messagesQ.data ?? [];
  const perProperty = domains
    .filter((d) => d.planning)
    .map((d) => ({
      propertyId: d.property.id,
      bookings: d.planning!.bookings,
      links: d.links,
      unitNames: new Map(d.units.map((u) => [u.id, u.name])),
      checkinTime: d.settings?.checkinTime ?? "16:00",
      checkoutTime: d.settings?.checkoutTime ?? "10:00",
    }));
  const events = dayEvents(perProperty, today);
  const cleaning = cleaningTasks(perProperty, today, 1);
  const arrivals = events.filter((e) => e.kind === "arrive");
  const departures = events.filter((e) => e.kind === "depart");
  const overdue: OverviewBalance[] = overviews.list.flatMap((o) => o.alerts.overdueBalances);
  const incomplete = !!error || overviews.error || messagesQ.isError;
  const toCollect = [
    ...arrivals.filter((e) => e.booking.balanceCents > 0 && e.booking.status === "confirmed" && !isChannel(e.booking)).map((e) => ({ id: e.booking.id, name: e.booking.guestName, cents: e.booking.balanceCents, late: false })),
    ...overdue.filter((o) => !arrivals.some((e) => e.booking.id === o.id)).map((o) => ({ id: o.id, name: o.guestName ?? o.reference, cents: o.balanceCents, late: true })),
  ];
  const holds = overviews.list.flatMap((o) => o.alerts.activeHolds);
  return { incomplete, today, domains, isLoading, error, events, arrivals, departures, cleaning, toCollect, overdue, holds, messages };
}

function unitName(domains: DomainData[], b: PlanningBooking): string {
  for (const d of domains) {
    const u = d.units.find((x) => x.id === b.unitId);
    if (u) return u.name;
  }
  return "";
}

export function TodayPage() {
  const layout = useLayout();
  return layout === "A" ? <TodayA /> : <TodayB />;
}

// --- A ---------------------------------------------------------------------------

function TodayA() {
  const { t } = useLingui();
  const d = useDay();
  const navigate = useNavigate();
  const openBooking = useOpenBooking();
  const total = d.toCollect.reduce((s, x) => s + x.cents, 0);
  const list = (xs: string[]) => (xs.length > 2 ? [...xs.slice(0, 1), t`et ${xs.length - 1} autres`] : xs);
  const items: { k: string; icon: ReactNode; title: string; count: string; lines: string[]; onClick: () => void }[] = [
    {
      k: "arrive",
      icon: <IconLogin2 size={22} />,
      title: t`Arrivent`,
      count: String(d.arrivals.length),
      lines: d.arrivals.length ? list(d.arrivals.map((e) => `${hourLabel(e.time)}, ${unitName(d.domains, e.booking)} : ${e.booking.guestName}${isChannel(e.booking) ? t`, via ${channelName(e.booking)}` : ""}`)) : [t`Personne aujourd'hui.`],
      onClick: () => (d.arrivals[0] ? openBooking(d.arrivals[0].booking.id) : undefined),
    },
    {
      k: "part",
      icon: <IconLogout2 size={22} />,
      title: t`Partent`,
      count: String(d.departures.length),
      lines: d.departures.length ? list(d.departures.map((e) => `${hourLabel(e.time)}, ${unitName(d.domains, e.booking)} : ${e.booking.guestName}`)) : [t`Personne aujourd'hui.`],
      onClick: () => (d.departures[0] ? openBooking(d.departures[0].booking.id) : undefined),
    },
    {
      k: "menage",
      icon: <IconBrush size={22} />,
      title: t`Ménage`,
      count: String(d.cleaning.length),
      lines: d.cleaning.length ? list(d.cleaning.map((c) => (c.tight && c.next ? t`${c.unitName}, à finir avant ${hourLabel(c.next.checkinTime)}` : t`${c.unitName}, après ${hourLabel(c.time)}`))) : [t`Aucun ménage aujourd'hui.`],
      onClick: () => void navigate({ to: "/menage" }),
    },
    {
      k: "euro",
      icon: <IconCurrencyEuro size={22} />,
      title: t`À encaisser`,
      count: eur(total),
      lines: d.toCollect.length ? list(d.toCollect.map((x) => `${x.name} : ${eur(x.cents)}${x.late ? t`, en retard` : t` à l'arrivée`}`)) : [t`Rien à encaisser aujourd'hui.`],
      onClick: () => (d.toCollect[0] ? openBooking(d.toCollect[0].id) : undefined),
    },
    {
      k: "msg",
      icon: <IconMessage size={22} />,
      title: t`Messages`,
      count: String(d.messages.length),
      lines: d.messages.length ? list(d.messages.map((m) => `${m.fromName || m.fromEmail} : ${m.subject}`)) : [t`Aucun message en attente.`],
      onClick: () => void navigate({ to: "/messages" }),
    },
  ];
  return (
    <CalendarView
      title={titleDate(d.today)}
      before={
        <>
        {d.incomplete ? <ErrorLine text={t`Une partie des données n'a pas pu être lue : les chiffres ci-dessous peuvent être incomplets. Rechargez la page.`} /> : null}
        <div className="today" aria-label={t`La journée`}>
          {items.map((x) => (
            <button key={x.k} type="button" className="t-item" data-k={x.k} onClick={x.onClick}>
              <span className="t-h">
                {x.icon}
                {x.title}
                <b>{x.count}</b>
              </span>
              {x.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </button>
          ))}
        </div>
        </>
      }
    />
  );
}

// --- B ---------------------------------------------------------------------------

function Contact({ bookingId, sms = true }: { bookingId: number; sms?: boolean }) {
  const { t } = useLingui();
  const detail = useBooking(bookingId).data;
  const phone = useGuest(detail?.booking.guestId).data?.phone?.replace(/[^\d+]/g, "");
  if (!phone) return null;
  return (
    <>
      <a className="btn" href={`tel:${phone}`}>
        <IconPhone size={22} />
        {t`Appeler`}
      </a>
      {sms ? (
        <a className="btn" href={`sms:${phone}`}>
          <IconDeviceMobileMessage size={22} />
          {t`SMS`}
        </a>
      ) : null}
    </>
  );
}

function CleaningCard({ c }: { c: CleaningTask }) {
  const { t } = useLingui();
  const { isDone, toggle } = useCleaningDone();
  const done = isDone(c.key);
  return (
    <article className={`card${done ? " done" : ""}`}>
      <span className="kind">
        <IconBrush size={22} />
        {t`Ménage`}
      </span>
      <h3>{c.tight && c.next ? t`${c.unitName}, à finir avant ${hourLabel(c.next.checkinTime)}` : c.isComposite ? t`Les deux maisons, après le Domaine` : c.unitName}</h3>
      <p>{c.next ? t`Prochains voyageurs : ${c.next.persons} personnes, ${c.next.checkin === c.date ? t`aujourd'hui` : longDate(c.next.checkin)}.` : t`Pas d'arrivée prévue ensuite.`}</p>
      <button type="button" className="tick" role="checkbox" aria-checked={done} onClick={() => toggle(c.key)} style={{ ["--k" as string]: "var(--men)" }}>
        <span className="box">
          <IconCheckSmall />
        </span>
        <span>
          {t`Ménage fait`}
          <small>{done ? t`noté sur cet appareil (pilote)` : t`touchez quand la maison est prête`}</small>
        </span>
      </button>
    </article>
  );
}

function IconCheckSmall() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function EventCard({ e, domains }: { e: DayEvent; domains: DomainData[] }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  const b = e.booking;
  const nights = Math.round((Date.parse(b.checkout) - Date.parse(b.checkin)) / 86_400_000);
  const where = unitName(domains, b);
  if (e.kind === "depart") {
    return (
      <article className="card">
        <span className="kind">
          <IconLogout2 size={22} />
          {t`Départ`}
        </span>
        <h3>{where}</h3>
        <p>{t`${b.guestName}, ${b.persons} personnes, après ${nights > 1 ? t`${nights} nuits` : t`1 nuit`}.`}</p>
        <div className="row-b">
          <Contact bookingId={b.id} />
          <button type="button" className="btn" onClick={() => openBooking(b.id)}>
            {t`Fiche`}
          </button>
        </div>
      </article>
    );
  }
  const channel = isChannel(b);
  return (
    <article className="card">
      <span className="kind">
        <IconLogin2 size={22} />
        {t`Arrivée`}
      </span>
      <h3>{where}</h3>
      <p>
        {t`${b.guestName}, ${b.persons} personnes, ${nights > 1 ? t`${nights} nuits` : t`1 nuit`}.`} {channel ? t`Réservé et payé sur ${channelName(b)}.` : b.source === "manual" ? t`Réservé par téléphone.` : t`Réservé sur ${channelName(b)}.`}
      </p>
      {!channel && b.balanceCents > 0 ? (
        <p>
          {t`Reste à payer à l'arrivée :`} <span className="amount">{eur(b.balanceCents)}</span>
        </p>
      ) : null}
      <div className="row-b">
        <Contact bookingId={b.id} />
        {!channel && b.balanceCents > 0 ? (
          <button type="button" className="btn pri" onClick={() => openBooking(b.id)}>
            {t`Encaisser ${eur(b.balanceCents)}`}
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => openBooking(b.id)}>
            {t`Fiche`}
          </button>
        )}
      </div>
    </article>
  );
}

function TodayB() {
  const { t } = useLingui();
  const d = useDay();
  const navigate = useNavigate();
  const openBooking = useOpenBooking();
  const tight = d.cleaning.find((c) => c.tight && c.next);
  const nMsg = d.messages.length;
  const nPay = d.toCollect.length;
  const tail = [
    nPay ? (nPay > 1 ? t`${nombre(nPay)} soldes à encaisser` : t`un solde à encaisser`) : "",
    nMsg ? (nMsg > 1 ? t`${nombre(nMsg)} messages à lire` : t`un message à lire`) : "",
  ].filter(Boolean);
  const tailRaw = tail.length ? tail.join(", ") + "." : "";
  const tailText = tailRaw.charAt(0).toUpperCase() + tailRaw.slice(1);

  type RailItem = { key: string; time: string; k: string; node: ReactNode };
  const rail: RailItem[] = [];
  for (const e of d.events) {
    rail.push({ key: `${e.kind}${e.booking.id}`, time: e.time, k: e.kind === "arrive" ? "k-arr" : "k-dep", node: <EventCard e={e} domains={d.domains} /> });
  }
  for (const c of d.cleaning) {
    // Le ménage commence après le départ : on le place une heure plus tard.
    const [h, m] = c.time.split(":");
    const after = `${String(Math.min(23, Number(h) + 1)).padStart(2, "0")}:${m ?? "00"}`;
    rail.push({ key: `men${c.key}`, time: after, k: "k-men", node: <CleaningCard c={c} /> });
  }
  rail.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  const week = Array.from({ length: 7 }, (_, i) => addDays(d.today, i + 1)).map((day) => {
    const per = d.domains.filter((x) => x.planning);
    const arr = per.flatMap((x) => x.planning!.bookings.filter((b) => b.checkin === day).map((b) => `${unitName(d.domains, b)}`));
    const dep = per.flatMap((x) => x.planning!.bookings.filter((b) => b.checkout === day).map((b) => `${unitName(d.domains, b)}`));
    const parts: string[] = [];
    if (dep.length) parts.push(dep.length > 1 ? t`${nombre(dep.length)} départs (${dep.join(", ")}), donc ${nombre(dep.length)} ménages` : t`Départ : ${dep[0]}, ménage à prévoir`);
    if (arr.length) parts.push(arr.length > 1 ? t`${nombre(arr.length)} arrivées (${arr.join(", ")})` : t`Arrivée : ${arr[0]}`);
    return { day, text: parts.length ? parts.join(". ") + "." : "" };
  });

  return (
    <div className="wrap2">
      <section className="day" aria-labelledby="h-jour">
        <h1 id="h-jour">{titleDate(d.today)}</h1>
        <p className="sum">
          {daySentence(d.arrivals.length, d.departures.length)} {tight && tight.next ? <b>{t`${tight.unitName} doit être prête pour ${hourLabel(tight.next.checkinTime)}.`}</b> : null} {tailText}
        </p>
        {d.incomplete ? <ErrorLine text={t`Une partie des données n'a pas pu être lue : la journée peut être incomplète. Rechargez la page.`} /> : null}
        {d.isLoading && rail.length === 0 ? <p className="loading">{t`Chargement de la journée…`}</p> : null}
        {rail.length ? (
          <ol className="rail">
            {rail.map((r) => (
              <li key={r.key} className={r.k}>
                <span className="hr">{hourLabel(r.time)}</span>
                <span className="dot" />
                {r.node}
              </li>
            ))}
          </ol>
        ) : !d.isLoading ? (
          <div className="empty">
            <h3>{t`Journée calme`}</h3>
            <p>{t`Personne n'arrive ni ne part aujourd'hui. Le calendrier montre les semaines à venir.`}</p>
            <button type="button" className="btn" onClick={() => void navigate({ to: "/calendrier" })}>
              {t`Ouvrir le calendrier`}
            </button>
          </div>
        ) : null}

        {d.overdue.length || d.holds.length || d.messages.length ? (
          <h2 className="sec">
            <Trans>À régler sans heure fixe</Trans>
          </h2>
        ) : null}
        <div className="plain">
          {d.overdue.map((o) => (
            <article key={`o${o.id}`} className="card k-eur">
              <span className="kind">
                <IconCurrencyEuro size={22} />
                {t`Solde en retard`}
              </span>
              <h3>
                {o.guestName ?? o.reference} : <span className="amount">{eur(o.balanceCents)}</span>
              </h3>
              <p>{t`${o.unitName}, ${stayRange(o.checkin, o.checkout)}.`} {o.balanceDueDate ? t`Le solde était attendu le ${longDate(o.balanceDueDate)}.` : ""}</p>
              <div className="row-b">
                <Contact bookingId={o.id} sms={false} />
                <ActionButton className="pri" run={() => api(`/bookings/${o.id}/balance-reminder`, { method: "POST" })} ok={t`C'est fait. Rappel envoyé par mail.`}>
                  {t`Envoyer un rappel`}
                </ActionButton>
              </div>
            </article>
          ))}
          {d.holds.map((h) => (
            <article key={`h${h.id}`} className="card k-opt">
              <span className="kind">
                <IconLock size={22} />
                {t`Option en attente des arrhes`}
              </span>
              <h3>{h.unitName}</h3>
              <p>{h.holdExpiresAt ? t`Sans arrhes reçues, les dates se libèrent le ${longDate(h.holdExpiresAt.slice(0, 10))}.` : t`Arrhes pas encore reçues.`}</p>
              <div className="row-b">
                <button type="button" className="btn pri" onClick={() => openBooking(h.id)}>
                  {t`Ouvrir la fiche`}
                </button>
              </div>
            </article>
          ))}
          {d.messages.slice(0, 3).map((m: Message) => (
            <article key={`m${m.id}`} className="card k-msg">
              <span className="kind">
                <IconMessage size={22} />
                {t`Message à lire`}
              </span>
              <h3>{m.fromName || m.fromEmail}</h3>
              <p className="quote">{m.bodyText.slice(0, 160)}</p>
              <div className="row-b">
                <button type="button" className="btn pri" onClick={() => void navigate({ to: "/messages", search: { msg: m.id } })}>
                  {t`Répondre`}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <aside aria-labelledby="h-week">
        <section className="week">
          <h2 id="h-week">{t`Cette semaine`}</h2>
          <p className="muted" style={{ margin: "0 0 10px" }}>
            {t`Ce qui arrive après aujourd'hui.`}
          </p>
          <ol>
            {week.map((w) => (
              <li key={w.day} className={w.text ? "" : "calm"}>
                <b>
                  {weekdayShort(w.day).replace(/^./, (c) => c.toUpperCase())} {dayNum(w.day)}
                </b>
                <span>{w.text || t`Rien de prévu.`}</span>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  );
}
