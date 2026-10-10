// « À vérifier en coulisses » : la carte Santé de l'ancien tableau de bord
// (paiement sans séjour, trop-perçu, mail parti en erreur, liaison Beds24
// figée, dérives lentes), repliée sous une ligne tant qu'on ne l'ouvre pas.
import { useLingui } from "@lingui/react/macro";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";

import type { Overview } from "../api/types";
import { eur } from "../lib/money";
import { useOpenBooking } from "./Shell";

const ROUTES: Record<string, string> = { "#/ical": "/reglages/calendriers", "#/canaux": "/reglages/plateformes", "#/tarifs": "/reglages/tarifs", "#/messages": "/messages" };

export function HealthStrip({ overviews }: { overviews: Overview[] }) {
  const { t } = useLingui();
  const openBooking = useOpenBooking();
  const navigate = useNavigate();
  const rows: { key: string; text: string; go?: () => void }[] = [];
  for (const o of overviews) {
    const h = o.health;
    if (!h) continue;
    const where = overviews.length > 1 ? `${o.property.name} : ` : "";
    for (const p of h.orphanPayments) rows.push({ key: `op${p.bookingId}`, text: t`${where}${p.reference} : ${eur(p.amountCents)} encaissés alors que la réservation n'est pas confirmée. À rembourser ou à reloger aujourd'hui.`, go: () => openBooking(p.bookingId) });
    for (const p of h.overpaidBookings) rows.push({ key: `ov${p.bookingId}`, text: t`${where}${p.reference} : ${eur(p.overpaidCents)} reçus en trop. À rembourser.`, go: () => openBooking(p.bookingId) });
    for (const [i, m] of h.failedEmails.entries())
      rows.push({ key: `fm${o.property.id}-${i}`, text: t`${where}un mail à ${m.toEmail}${m.reference ? t` (${m.reference})` : ""} n'est pas parti : le client n'a rien reçu.`, go: m.bookingId ? () => openBooking(m.bookingId!) : undefined });
    if (h.beds24Stale) rows.push({ key: `b${o.property.id}`, text: t`${where}aucune nouvelle de Beds24 depuis ${h.beds24StaleHours ?? "?"} h : les plateformes peuvent vendre des dates déjà prises.`, go: () => void navigate({ to: "/reglages/plateformes" }) });
    for (const [i, d] of h.drift.entries()) rows.push({ key: `d${o.property.id}-${i}`, text: `${where}${d.detail}`, go: ROUTES[d.href] ? () => void navigate({ to: ROUTES[d.href]! }) : undefined });
    if (h.recentErrors.length) rows.push({ key: `e${o.property.id}`, text: t`${where}${h.recentErrors.length} erreur(s) technique(s) ces dernières 24 h (détail dans Réglages, Journaux).`, go: () => void navigate({ to: "/reglages/journaux" }) });
  }
  if (rows.length === 0) return null;
  return (
    <details className="health">
      <summary>
        <IconAlertTriangle size={22} />
        {rows.length > 1 ? t`${rows.length} points à vérifier en coulisses` : t`1 point à vérifier en coulisses`}
      </summary>
      <ul>
        {rows.map((r) => (
          <li key={r.key}>
            {r.go ? (
              <button type="button" onClick={r.go}>
                {r.text}
              </button>
            ) : (
              r.text
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
