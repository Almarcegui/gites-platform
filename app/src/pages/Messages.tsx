// Messages : la liste, le fil, la réponse à partir d'un modèle, « traité ».
// PILOTE : les quatre modèles sont en constantes (lib/templates.ts).
import { Trans, useLingui } from "@lingui/react/macro";
import { IconChevronLeft, IconSend } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import { useBooking, useMessages } from "../api/hooks";
import type { Message } from "../api/types";
import { ActionButton, ErrorLine, useAction } from "../lib/action";
import { hourLabel, longDate, todayBrussels, whenLabel } from "../lib/dates";
import { eur } from "../lib/money";
import { fillTemplate, templateLabels, type TemplateId } from "../lib/templates";
import { useLayout } from "../lib/useLayout";
import { deliveryText } from "../booking/BookingPanel";
import { useOpenBooking } from "../shell/Shell";

function sourceLabel(m: Message): { cls: string; text: string } {
  return m.channel === "form" ? { cls: "st", text: "Votre site" } : { cls: "", text: "Mail" };
}

export function MessagesPage() {
  const { t } = useLingui();
  const layout = useLayout();
  const [filter, setFilter] = useState<"nouveau" | "all">("nouveau");
  const pending = useMessages("nouveau");
  const all = useMessages();
  const list = (filter === "nouveau" ? pending.data : all.data) ?? [];
  const wanted = (useSearch({ strict: false }) as { msg?: number }).msg ?? null;
  const [selected, setSelected] = useState<number | null>(wanted);
  const today = todayBrussels();
  useEffect(() => {
    if (layout === "A" && selected == null && list[0]) setSelected(list[0].id);
  }, [layout, list, selected]);
  const current = (all.data ?? []).find((m) => m.id === selected) ?? list.find((m) => m.id === selected) ?? null;
  const showList = layout === "A" || selected == null;
  const showThread = current != null && (layout === "A" || selected != null);
  return (
    <div className="msgs">
      {showList ? (
        <section className="panel" aria-labelledby="h-in" style={{ alignSelf: "start" }}>
          <h1 id="h-in" className="sub" style={{ padding: "14px 16px 6px", margin: 0 }}>
            <Trans>Messages</Trans>
          </h1>
          <div className="chips" style={{ padding: "4px 12px 10px" }}>
            <button type="button" className="chip" aria-pressed={filter === "nouveau"} onClick={() => setFilter("nouveau")}>
              {t`À répondre (${pending.data?.length ?? 0})`}
            </button>
            <button type="button" className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              {t`Tous`}
            </button>
          </div>
          <p className="muted" style={{ margin: 0, padding: "0 16px 12px", fontSize: 15 }}>
            <Trans>Les messages de votre site et les mails des clients arrivent ici. Ceux d'Airbnb et de Booking suivront.</Trans>
          </p>
          {(filter === "nouveau" ? pending : all).error ? <ErrorLine text={t`Les messages n'ont pas pu être lus.`} /> : null}
          {list.length === 0 ? (
            <p style={{ padding: "12px 16px 16px", margin: 0 }}>{filter === "nouveau" ? t`Aucun message en attente. Tout est répondu.` : t`Aucun message pour l'instant.`}</p>
          ) : null}
          {list.map((m) => {
            const src = sourceLabel(m);
            return (
              <button key={m.id} type="button" className={`conv${m.status === "traité" ? " read" : ""}`} aria-current={m.id === selected} onClick={() => setSelected(m.id)}>
                <span className="who">
                  <span>{m.fromName || m.fromEmail}</span>
                  <small>{whenLabel(m.receivedAt, today)}</small>
                </span>
                <p>
                  <span className={`src ${src.cls}`}>{src.text}</span>
                  {m.subject}
                </p>
              </button>
            );
          })}
        </section>
      ) : null}
      {showThread && current ? <Thread key={current.id} message={current} onBack={layout === "B" ? () => setSelected(null) : undefined} /> : null}
    </div>
  );
}

function Thread({ message, onBack }: { message: Message; onBack?: () => void }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  const today = todayBrussels();
  const thread = useQuery({
    queryKey: ["thread", message.id],
    queryFn: () => api<{ message: Message; thread: Message[] }>(`/messages/${message.id}/thread`),
  });
  const booking = useBooking(message.bookingId).data?.booking;
  const times = useQuery({
    queryKey: ["settings", booking?.propertyId ?? message.propertyId],
    queryFn: () => api<{ settings: { checkinTime: string; checkoutTime: string } }>("/settings", { query: { property: booking?.propertyId ?? message.propertyId ?? 1 } }).then((r) => r.settings),
    staleTime: 5 * 60_000,
  }).data;
  const [text, setText] = useState("");
  const [tpl, setTpl] = useState<TemplateId | null>(null);
  const send = useAction();
  const balance = booking ? booking.totalCents - booking.paidCents : 0;
  const ctx = {
    firstName: (message.fromName ?? "").trim().split(/\s+/)[0] ?? "",
    unitName: booking?.unitName ?? "",
    arrival: booking ? longDate(booking.checkin) : "",
    checkinTime: hourLabel(times?.checkinTime ?? "16:00"),
    checkoutTime: hourLabel(times?.checkoutTime ?? "10:00"),
    balance: balance > 0 ? eur(balance) : null,
    signature: booking?.unitName ?? "",
  };
  const items = thread.data?.thread ?? [message];
  return (
    <section className="thread" aria-labelledby="h-th">
      <div className="th-head">
        {onBack ? (
          <button type="button" className="btn icon ghost" aria-label={t`Retour à la liste`} onClick={onBack}>
            <IconChevronLeft size={22} />
          </button>
        ) : null}
        <h2 id="h-th">{message.fromName || message.fromEmail}</h2>
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
            t`Pas de réservation liée. ${message.fromEmail}`
          )}
        </p>
      </div>
      {thread.isLoading ? <p className="loading">{t`Chargement du fil…`}</p> : null}
      {thread.error ? <ErrorLine text={t`Le fil de la conversation n'a pas pu être lu. Rechargez la page avant de répondre.`} /> : null}
      {items.map((m) => (
        <div key={m.id} className={`bub${m.direction === "out" ? " out" : ""}`}>
          <small>
            {m.direction === "out" ? t`Vous` : m.fromName || m.fromEmail}, {whenLabel(m.receivedAt, today)} — {m.subject}
          </small>
          {m.bodyText}
        </div>
      ))}
      <p className="tpl" id="tpl-l">
        <Trans>Partir d'un modèle</Trans>
      </p>
      <div className="chips" role="group" aria-labelledby="tpl-l">
        {templateLabels().map((x) => (
          <button
            key={x.id}
            type="button"
            className="chip"
            aria-pressed={tpl === x.id}
            onClick={() => {
              setTpl(x.id);
              setText(fillTemplate(x.id, ctx));
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <label htmlFor="rep" className="tpl">
        <Trans>Votre réponse</Trans>
      </label>
      <textarea id="rep" className="reply" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      {send.state.status === "error" ? <ErrorLine text={t`Pas envoyé. ${send.state.text} Votre texte est gardé.`} /> : null}
      <div className="send">
        <p>{t`La réponse part par mail à ${message.fromEmail}${message.bookingId ? t` et s'affiche sur la page du client` : ""}.`}</p>
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
          disabled={send.state.status === "busy" || text.trim().length < 2 || !!thread.error}
          onClick={async () => {
            if (await send.run(() => api<{ delivery: string }>(`/messages/${message.id}/reply`, { method: "POST", body: { body: text } }), (r) => deliveryText((r as { delivery?: string }).delivery))) setText("");
          }}
        >
          <IconSend size={20} />
          {send.state.status === "busy" ? t`Un instant…` : t`Envoyer`}
        </button>
      </div>
    </section>
  );
}
