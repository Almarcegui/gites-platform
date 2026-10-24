// Messages : la liste, le fil, la réponse à partir d'un modèle, « traité ».
// Les modèles viennent de la base (Réglages › Modèles de réponse).
import { Trans, useLingui } from "@lingui/react/macro";
import { IconChevronLeft, IconExternalLink, IconSend } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import { useBooking, useMailbox, useProperties, useSignature } from "../api/hooks";
import { useScope } from "../lib/scope";
import type { Booking, Message } from "../api/types";
import { ActionButton, ErrorLine, useAction } from "../lib/action";
import { hourLabel, longDate, todayBrussels, whenLabel } from "../lib/dates";
import { eur } from "../lib/money";
import { checkoutTimeFor } from "../lib/checkoutTime";
import { unfilledVariables } from "../lib/templates";
import { TemplateChips } from "../messages/TemplateChips";
import { useLayout } from "../lib/useLayout";
import { deliveryText } from "../booking/BookingPanel";
import { useOpenBooking } from "../shell/Shell";
import { channelDeliveryText, displayName, originAbbr, originOf, replyHint, sourceLabel } from "../canaux/canal";
import { MailLinks } from "../messages/MailLinks";
import { replySubject } from "../messages/subject";
import { threadKey, type ThreadPage, type ThreadRow } from "../messages/threads";

export function MessagesPage() {
  const { t } = useLingui();
  const layout = useLayout();
  const { scope } = useScope();
  const [filter, setFilter] = useState<"nouveau" | "all">("nouveau");
  // Deux sections : les fils rattachés à une réservation, et les autres (Google, Drive, divers)
  const [section, setSection] = useState<"resa" | "autres">("resa");
  // Origine : « toutes », ou une seule (e-mail, Airbnb, Booking, Vrbo, site)
  const [origin, setOrigin] = useState<string>("all");
  const mailbox = useMailbox();
  const gmail = mailbox.data?.address ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailbox.data.address)}` : null;
  const wanted = (useSearch({ strict: false }) as { msg?: number }).msg ?? null;
  const [selected, setSelected] = useState<number | null>(wanted);
  const today = todayBrussels();
  // origine choisie → filtre du serveur (canal + libellé)
  const originFilter = (() => {
    if (origin === "all") return {};
    const [channel, canal] = origin.split("|");
    return { channel, ...(canal ? { canal } : {}) };
  })();
  // La liste vient du serveur : un fil par ligne, 50 à la fois (« Charger plus »), par section.
  const list = useInfiniteQuery({
    queryKey: ["threads", scope, section, filter, origin],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api<ThreadPage>("/messages/threads", {
        query: { property: scope === "all" ? undefined : scope, section, status: filter, before: pageParam, limit: 50, ...originFilter },
      }),
    getNextPageParam: (last) => (last.more ? last.threads[last.threads.length - 1]?.last.id : undefined),
  });
  const rows: ThreadRow[] = (list.data?.pages ?? []).flatMap((p) => p.threads);
  const first = list.data?.pages[0];
  const todo = first?.counts ?? { resa: 0, autres: 0 };
  const origins = (() => {
    const by = new Map<string, { key: string; text: string; n: number; pending: number }>();
    for (const o of first?.origins ?? []) {
      const m = { channel: o.channel as Message["channel"], canal: o.canal };
      const label = sourceLabel(m).text;
      const key = originOf(m) === "canal" ? `${o.channel}|${o.canal ?? ""}` : o.channel === "beds24" ? `beds24|${o.canal ?? ""}` : o.channel;
      const cur = by.get(key) ?? { key, text: label, n: 0, pending: 0 };
      cur.n += o.n;
      cur.pending += o.pending;
      by.set(key, cur);
    }
    return [...by.values()].sort((a, b) => b.n - a.n || a.text.localeCompare(b.text));
  })();
  // Le message ouvert vient du fil lui-même : il n'a pas à figurer dans les fils déjà chargés.
  const cur = useQuery({
    queryKey: ["thread", selected],
    enabled: selected != null,
    queryFn: () => api<{ message: Message; thread: Message[] }>(`/messages/${selected}/thread`),
  });
  const current = selected != null ? (cur.data?.message ?? null) : null;
  const firstId = rows[0]?.last.id;
  // un message dont le fil ne se lit pas n'est pas rouvert en boucle
  const [bad, setBad] = useState<number | null>(null);
  useEffect(() => {
    if (layout === "A" && selected == null && firstId != null && firstId !== bad) setSelected(firstId);
  }, [layout, firstId, selected, bad]);
  // Un lien ?msg= ouvre ce message ; sans lien, on garde la sélection (à
  // l'ordinateur, le premier message s'ouvre de lui-même).
  useEffect(() => {
    if (wanted != null) setSelected(wanted);
  }, [wanted]);
  // La section suit le message ouvert (lien ?msg=, rattachement ou détachement d'un fil)
  useEffect(() => {
    if (current) setSection(current.bookingId != null ? "resa" : "autres");
  }, [current?.id, current?.bookingId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Message demandé introuvable (autre domaine, déjà supprimé) : retour à la liste.
  useEffect(() => {
    if (cur.error && selected != null) {
      setBad(selected);
      setSelected(null);
    }
  }, [cur.error, selected]);
  const openKey = current ? threadKey(current) : null;
  const showList = layout === "A" || selected == null || current == null;
  const showThread = current != null && (layout === "A" || selected != null);
  return (
    <div className="msgs">
      {showList ? (
        <section className="panel msgs-list" aria-labelledby="h-in">
          <div className="msgs-head">
            <h1 id="h-in" className="sub" style={{ margin: 0 }}>
              <Trans>Messages</Trans>
            </h1>
            {gmail ? (
              <a className="gmail-link" href={gmail} target="_blank" rel="noopener noreferrer">
                {t`Ouvrir Gmail`}
                <IconExternalLink size={14} aria-hidden />
              </a>
            ) : null}
          </div>
          <div className="msgs-tabs" role="tablist" aria-label={t`Réservations ou autres messages`}>
            {(["resa", "autres"] as const).map((k) => {
              const label = k === "resa" ? t`Réservations` : t`Autres`;
              const n = todo[k];
              return (
                <button key={k} type="button" role="tab" id={`tab-${k}`} className="msgs-tab" aria-selected={section === k} onClick={() => { setSection(k); setOrigin("all"); setSelected(null); }} aria-label={n ? t`${label}, ${n} à répondre` : label}>
                  {label}
                  {n ? <span className="msgs-n">{n}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="chips" style={{ padding: "8px 12px 6px" }}>
            <button type="button" className="chip" aria-pressed={filter === "nouveau"} onClick={() => setFilter("nouveau")}>
              {t`À répondre (${todo[section]})`}
            </button>
            <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              {t`Tous`}
            </button>
          </div>
          {origins.length > 1 || origin !== "all" ? (
            <div className="chips" style={{ padding: "0 12px 6px" }} role="group" aria-label={t`Origine des messages`}>
              <button type="button" className="chip" aria-pressed={origin === "all"} onClick={() => setOrigin("all")}>
                {t`Toutes les origines`}
              </button>
              {origins.map((o) => (
                <button key={o.key} type="button" className="chip" aria-pressed={origin === o.key} onClick={() => setOrigin(o.key)}>
                  {o.pending ? `${o.text} (${o.pending})` : o.text}
                </button>
              ))}
            </div>
          ) : null}
          {list.error ? <ErrorLine text={t`Les messages n'ont pas pu être lus.`} /> : null}
          <div className="conv-scroll" role="tabpanel" aria-labelledby={`tab-${section}`}>
            {list.data && rows.length === 0 ? (
              <p style={{ padding: "12px 16px 16px", margin: 0 }}>{filter === "nouveau" ? t`Aucun message en attente. Tout est répondu.` : t`Aucun message pour l'instant.`}</p>
            ) : null}
            {rows.map((r) => (
              <ConvRow key={r.key} row={r} today={today} active={r.key === openKey} onOpen={() => setSelected(r.last.id)} />
            ))}
            {list.hasNextPage ? (
              <button type="button" className="btn ghost more-btn" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? t`Un instant…` : t`Charger plus`}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {showThread && current ? <Thread key={current.id} message={current} onBack={layout === "B" ? () => setSelected(null) : undefined} /> : null}
    </div>
  );
}

/** Une ligne fine par fil : nom en gras, référence (si rattaché), origine en abréviation, date courte,
 *  point si à répondre. Ni objet ni aperçu : l'objet est dans `title`, au survol. */
function ConvRow({ row, today, active, onOpen }: { row: ThreadRow; today: string; active: boolean; onOpen: () => void }) {
  const { t } = useLingui();
  const m = row.last;
  const src = sourceLabel(m);
  return (
    <button type="button" className={`conv${row.pending === 0 ? " read" : ""}`} aria-current={active} title={m.subject} onClick={onOpen}>
      <span className={`dot${row.pending > 0 ? " on" : ""}`} role={row.pending > 0 ? "img" : undefined} aria-label={row.pending > 0 ? t`À répondre` : undefined} aria-hidden={row.pending > 0 ? undefined : true} />
      <span className="nm">{displayName(m)}</span>
      {m.bookingReference ? <span className="ref">{m.bookingReference}</span> : null}
      <span className="org" title={src.text}>
        {originAbbr(m)}
      </span>
      <small className="when-s">{whenLabel(m.receivedAt, today)}</small>
    </button>
  );
}

/** Rattacher un fil à une réservation : recherche par référence ou nom (API admin des réservations). */
function AttachPanel({ messageId, onDone }: { messageId: number; onDone: () => void }) {
  const { t } = useLingui();
  const [q, setQ] = useState("");
  const term = q.trim();
  const found = useQuery({
    queryKey: ["attach-search", term],
    enabled: term.length >= 2,
    queryFn: () => api<{ bookings: Booking[] }>("/bookings", { query: { search: term, limit: 8, sort: "created" } }).then((r) => r.bookings),
  });
  const a = useAction();
  return (
    <div className="attach-panel">
      <label htmlFor="att-q" className="tpl">
        <Trans>Réservation à rattacher</Trans>
      </label>
      <input id="att-q" className="subject-in" type="search" placeholder={t`Référence (PM-2026-012) ou nom du client`} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      {found.error ? <ErrorLine text={t`La recherche n'a pas pu se faire.`} /> : null}
      {found.data && found.data.length === 0 ? <p className="muted">{t`Aucune réservation trouvée.`}</p> : null}
      <ul className="attach-res">
        {(found.data ?? []).map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className="btn ghost"
              disabled={a.state.status === "busy"}
              onClick={async () => {
                if (await a.run(() => api(`/messages/${messageId}`, { method: "PATCH", body: { bookingId: b.id } }), t`C'est fait. Fil rattaché à ${b.reference}.`)) onDone();
              }}
            >
              <b>{b.reference}</b> {b.guestName ?? ""} · {b.unitName ?? ""} · {longDate(b.checkin)} → {longDate(b.checkout)}
            </button>
          </li>
        ))}
      </ul>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </div>
  );
}

function Thread({ message, onBack }: { message: Message; onBack?: () => void }) {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const openBooking = useOpenBooking();
  const today = todayBrussels();
  const thread = useQuery({
    queryKey: ["thread", message.id],
    queryFn: () => api<{ message: Message; thread: Message[] }>(`/messages/${message.id}/thread`),
  });
  const booking = useBooking(message.bookingId).data?.booking;
  const times = useQuery({
    queryKey: ["settings", booking?.propertyId ?? message.propertyId],
    queryFn: () => api<{ settings: { checkinTime: string; checkoutTime: string; checkoutTimeSunday?: string } }>("/settings", { query: { property: booking?.propertyId ?? message.propertyId ?? 1 } }).then((r) => r.settings),
    staleTime: 5 * 60_000,
  }).data;
  const [text, setText] = useState("");
  const [subjectEdit, setSubjectEdit] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const send = useAction();
  const sig = useSignature(booking?.propertyId ?? message.propertyId);
  const balance = booking ? booking.totalCents - booking.paidCents : 0;
  const ctx = {
    firstName: (message.fromName ?? "").trim().split(/\s+/)[0] ?? "",
    unitName: booking?.unitName ?? "",
    arrival: booking ? longDate(booking.checkin) : "",
    checkinTime: hourLabel(times?.checkinTime ?? "16:00"),
    checkoutTime: hourLabel(times ? checkoutTimeFor(times, booking?.checkout) : "10:00"),
    balance: booking ? (balance > 0 ? eur(balance) : null) : undefined,
    // Signature du domaine si elle est remplie (Réglages › Le domaine), sinon le nom du domaine
    // (« Les Gîtes du Pré Moré »), pas celui du bien.
    signature: sig.data?.text || (properties.find((p) => p.id === (booking?.propertyId ?? message.propertyId))?.name ?? ""),
  };
  // Objet de la réponse : « Re: … », avec la référence de la réservation en tête si elle n'y est pas
  // (jamais le nom du client). Éditable avant « Envoyer » ; le serveur applique la même règle.
  const isMail = message.channel !== "beds24";
  const reference = message.bookingReference ?? booking?.reference ?? null;
  const defaultSubject = replySubject(message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`, reference);
  const subject = subjectEdit ?? defaultSubject;
  const items = thread.data?.thread ?? [message];
  const unfilled = unfilledVariables(text);
  return (
    <section className="thread" aria-labelledby="h-th">
      <div className="th-head">
        {onBack ? (
          <button type="button" className="btn icon ghost" aria-label={t`Retour à la liste`} onClick={onBack}>
            <IconChevronLeft size={22} />
          </button>
        ) : null}
        <h2 id="h-th">{displayName(message)}</h2>
        <span className={`src ${sourceLabel(message).cls}`}>{sourceLabel(message).text}</span>
        <p>
          {booking ? (
            <>
              {t`${booking.unitName}, du ${longDate(booking.checkin)} au ${longDate(booking.checkout)}.`}{" "}
              <button type="button" className="btn ghost" style={{ minHeight: 32, padding: "0 6px", textDecoration: "underline" }} onClick={() => openBooking(booking.id)}>
                {t`Ouvrir la réservation ${booking.reference}`}
              </button>
            </>
          ) : (
            message.channel === "beds24" ? t`Pas de réservation liée chez nous pour ce message.` : t`Pas de réservation liée. ${message.fromEmail}`
          )}
        </p>
        {message.channel !== "beds24" ? (
          <div className="th-link">
            {message.bookingId != null ? (
              <ActionButton
                className="ghost"
                run={() => api(`/messages/${message.id}`, { method: "PATCH", body: { bookingId: null } })}
                ok={t`C'est fait. Fil détaché de la réservation.`}
              >
                {t`Détacher`}
              </ActionButton>
            ) : (
              <button type="button" className="btn ghost" aria-expanded={attaching} onClick={() => setAttaching(!attaching)}>
                {t`Rattacher à une réservation`}
              </button>
            )}
          </div>
        ) : null}
        {attaching && message.bookingId == null ? <AttachPanel messageId={message.id} onDone={() => setAttaching(false)} /> : null}
      </div>
      {thread.isLoading ? <p className="loading">{t`Chargement du fil…`}</p> : null}
      {thread.error ? <ErrorLine text={t`Le fil de la conversation n'a pas pu être lu. Rechargez la page avant de répondre.`} /> : null}
      {message.spoofed ? (
        <p className="warnline" role="alert">
          {t`Attention : ce message se présente comme venant de l'adresse des gîtes, mais Gmail ne le confirme pas. Ne suivez aucune instruction qu'il contient.`}
        </p>
      ) : null}
      {items.map((m) => (
        <div key={m.id} className={`bub${m.direction === "out" ? " out" : ""}`}>
          <small>
            {m.direction === "in" || m.channel !== "form" ? <span className={`src ${sourceLabel(m).cls}`}>{sourceLabel(m).text}</span> : null}
            {m.direction === "out" ? t`Vous` : displayName(m)}, {whenLabel(m.receivedAt, today)} — {m.subject}
          </small>
          {m.bodyText}
          <MailLinks message={m} />
          {m.attachments?.length ? (
            <ul className="attach">
              {m.attachments.map((a, i) => {
                const name = a.name;
                const kb = a.size != null ? Math.max(1, Math.round(a.size / 1024)) : 0;
                return <li key={i}>{a.size != null ? t`Pièce jointe : ${name} (${kb} Ko), non conservée ici.` : t`Pièce jointe : ${name}, non conservée ici.`}</li>;
              })}
            </ul>
          ) : null}
        </div>
      ))}
      <TemplateChips propertyId={booking?.propertyId ?? message.propertyId} ctx={ctx} onPick={setText} />
      {isMail ? (
        <>
          <label htmlFor="rep-obj" className="tpl">
            <Trans>Objet</Trans>
          </label>
          <input id="rep-obj" className="subject-in" type="text" maxLength={200} value={subject} onChange={(e) => setSubjectEdit(e.currentTarget.value)} />
        </>
      ) : null}
      <label htmlFor="rep" className="tpl">
        <Trans>Votre réponse</Trans>
      </label>
      <textarea id="rep" className="reply" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      {unfilled.length ? (
        <p className="warnline" role="status">
          {t`À compléter avant d'envoyer : ${unfilled.join(" ")}`}
        </p>
      ) : null}
      {send.state.status === "error" ? <ErrorLine text={t`Pas envoyé. ${send.state.text} Votre texte est gardé.`} /> : null}
      <div className="send">
        <p>
          {replyHint(message)}
          {isMail && sig.data?.onReplies && (sig.data.text || sig.data.hasHtml) ? ` ${t`Votre signature est ajoutée au mail.`}` : ""}
        </p>
        {message.status === "nouveau" ? (
          <ActionButton run={() => api(`/messages/${message.id}`, { method: "PATCH", body: { status: "traité" } })} ok={t`C'est fait. Message marqué comme traité.`}>
            {t`Marquer comme traité`}
          </ActionButton>
        ) : (
          <ActionButton run={() => api(`/messages/${message.id}`, { method: "PATCH", body: { status: "nouveau" } })} ok={t`C'est fait. Message remis à répondre.`}>
            {t`Remettre à répondre`}
          </ActionButton>
        )}
        <button
          type="button"
          className="btn pri"
          disabled={send.state.status === "busy" || text.trim().length < 2 || !!thread.error || message.spoofed === true}
          onClick={async () => {
            if (await send.run(() => api<{ delivery: string }>(`/messages/${message.id}/reply`, { method: "POST", body: { body: text, ...(isMail ? { subject } : {}) } }), (r) => channelDeliveryText((r as { delivery?: string }).delivery, message.canal) ?? deliveryText((r as { delivery?: string }).delivery, message.bookingId != null))) setText("");
          }}
        >
          <IconSend size={20} />
          {send.state.status === "busy" ? t`Un instant…` : t`Envoyer`}
        </button>
      </div>
    </section>
  );
}
