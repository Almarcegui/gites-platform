// Historique des échanges d'un client, dans sa fiche (Réglages › Clients) :
// les mails que la plateforme lui a envoyés et les messages reçus ou écrits
// (mail, site, Airbnb / Booking.com / Vrbo), rangés par séjour puis par date,
// avec un groupe « hors séjour ». Un clic sur une ligne en montre le contenu.
// Source : GET /guests/:id/history.
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { api } from "../../api/client";
import type { GuestHistory, HistoryItem, HistoryStay } from "../../api/types2";
import { ErrorLine } from "../../lib/action";
import { stayRange } from "../../lib/dates";
import { Loading, sqlWhen } from "../../ui/kit";

/** Les types de mails de la plateforme, dits en français simple. */
const MAIL_KINDS: Record<string, MessageDescriptor> = {
  confirmation: msg`Confirmation de réservation`,
  voucher: msg`Confirmation de réservation`,
  payment_link: msg`Lien de paiement`,
  balance_reminder: msg`Rappel du solde`,
  payment_receipt: msg`Reçu de paiement`,
  payment_failed: msg`Paiement non abouti`,
  cancellation: msg`Annulation`,
  abandon_reminder: msg`Relance : réservation commencée`,
  contact_ack: msg`Accusé de réception de votre message`,
  stay_j30: msg`Préparer votre séjour (J-30)`,
  stay_j7: msg`Infos d'arrivée (J-7)`,
  stay_j3: msg`Rappel avant l'arrivée (J-3)`,
  stay_after: msg`Merci et avis (après le séjour)`,
};

const OTHER_MAIL = msg`Autre mail`;

export function mailKindLabel(kind: string, _: (d: MessageDescriptor) => string): string {
  return _(MAIL_KINDS[kind] ?? OTHER_MAIL);
}

type Filter = "all" | "out" | "in";

export function ClientHistory({ guestId }: { guestId: number }) {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["guest-history", guestId], queryFn: () => api<GuestHistory>(`/guests/${guestId}/history`) });
  const [filter, setFilter] = useState<Filter>("all");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const counts = { all: items.length, out: items.filter((i) => i.direction === "out").length, in: items.filter((i) => i.direction === "in").length };
  const shown = useMemo(() => items.filter((i) => filter === "all" || i.direction === filter), [items, filter]);
  const groups = useMemo(() => {
    const stays = q.data?.stays ?? [];
    const out: { stay: HistoryStay | null; items: HistoryItem[] }[] = [];
    for (const s of stays) {
      const its = shown.filter((i) => i.bookingId === s.bookingId);
      if (its.length) out.push({ stay: s, items: its });
    }
    const loose = shown.filter((i) => i.bookingId == null);
    if (loose.length) out.push({ stay: null, items: loose });
    return out;
  }, [q.data, shown]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: t`Tous (${counts.all})` },
    { key: "out", label: t`Envoyés (${counts.out})` },
    { key: "in", label: t`Reçus (${counts.in})` },
  ];
  return (
    <section className="hx" aria-label={t`Échanges avec ce client`}>
      <h3 className="sub3">{t`Échanges de mails et messages`}</h3>
      {q.error ? <ErrorLine text={t`L'historique n'a pas pu être lu. Fermez la fiche et réessayez.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <>
          <div className="chips" role="group" aria-label={t`Afficher`}>
            {filters.map((f) => (
              <button key={f.key} type="button" className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          {items.length === 0 ? <p className="muted">{t`Aucun échange avec ce client pour l'instant.`}</p> : null}
          {items.length > 0 && shown.length === 0 ? <p className="muted">{filter === "in" ? t`Rien de reçu de ce client.` : t`Rien d'envoyé à ce client.`}</p> : null}
          {groups.map((g) => (
            <div key={g.stay?.bookingId ?? "hors"} className="hx-group">
              <h4 className="hx-stay">
                {g.stay ? (
                  <>
                    <b>{g.stay.unitName ?? g.stay.reference}</b>
                    <small>
                      {g.stay.reference}, {stayRange(g.stay.checkin, g.stay.checkout)}
                    </small>
                  </>
                ) : (
                  <>
                    <b>{t`Hors séjour`}</b>
                    <small>{t`Avant une réservation, ou sans réservation liée`}</small>
                  </>
                )}
              </h4>
              <div className="panel">
                {g.items.map((i) => (
                  <HistoryRow key={i.key} item={i} open={openKey === i.key} onToggle={() => setOpenKey(openKey === i.key ? null : i.key)} />
                ))}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}

function HistoryRow({ item: i, open, onToggle }: { item: HistoryItem; open: boolean; onToggle: () => void }) {
  const { t } = useLingui();
  const labels = useLabels();
  const title = labels.title(i);
  const who = i.address ? (i.direction === "out" ? t`à ${i.address}` : t`de ${i.address}`) : "";
  const state = labels.state(i);
  return (
    <div className="hx-item">
      <button type="button" className="list-row two" aria-expanded={open} onClick={onToggle}>
        <span>
          <b>{title}</b>
          <small>{i.subject || t`(sans objet)`}</small>
          <small>
            {sqlWhen(i.at)}
            {who ? `, ${who}` : ""}
          </small>
        </span>
        <span className={`hx-state ${i.status === "failed" ? "bad" : i.status === "stub" ? "off" : ""}`}>{state}</span>
      </button>
      {open ? (
        <div className="hx-body">
          {i.errorDetail ? <ErrorLine text={t`Raison : ${i.errorDetail}`} /> : null}
          <div className={`bub ${i.direction === "out" ? "out" : ""}`}>{i.bodyText || t`(message vide)`}</div>
          {i.attachments.length ? <p className="muted">{t`Pièces jointes : ${i.attachments.map((a) => a.name).join(", ")}`}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Les mots de chaque ligne : titre (type du mail ou de l'échange) et état. */
function useLabels() {
  const { t, i18n } = useLingui();
  const title = (i: HistoryItem): string => {
    if (i.source === "mail") return mailKindLabel(i.kind, (d) => i18n._(d));
    if (i.channel === "beds24") {
      const canal = i.canal ?? "";
      return i.direction === "out" ? t`Réponse sur ${canal}` : t`Message reçu de ${canal}`;
    }
    if (i.channel === "form") return i.direction === "out" ? t`Réponse de l'équipe` : t`Message écrit sur le site`;
    return i.direction === "out" ? t`Réponse de l'équipe` : t`Mail reçu du client`;
  };
  const state = (i: HistoryItem): string => {
    if (i.direction === "in") return t`reçu`;
    if (i.status === "failed") return t`pas parti`;
    if (i.status === "stub") return t`préparé, non envoyé (envoi coupé)`;
    if (i.status === "aucune") return t`écrit dans la messagerie`;
    return t`envoyé`;
  };
  return { title, state };
}
