// Réservations : recherche (nom, mail, référence), périodes, ouverture de la fiche.
import { Trans, useLingui } from "@lingui/react/macro";
import { Select, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { api } from "../api/client";
import type { Booking } from "../api/types";
import { bookingState } from "../booking/BookingPanel";
import { ErrorLine } from "../lib/action";
import { stayRange } from "../lib/dates";
import { channelName } from "../lib/derive";
import { eur } from "../lib/money";
import { useScope } from "../lib/scope";
import { useOpenBooking } from "../shell/Shell";
import { DownloadButton } from "../ui/kit";

type Period = "upcoming" | "current" | "past" | "";

export function BookingsPage() {
  const { t } = useLingui();
  const { scope } = useScope();
  const openBooking = useOpenBooking();
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<Period>("upcoming");
  const [status, setStatus] = useState<string>("");
  const [q] = useDebouncedValue(search.trim(), 250);
  const list = useQuery({
    queryKey: ["bookings", scope, period, q, status],
    queryFn: () =>
      api<{ bookings: Booking[] }>("/bookings", { query: { property: scope === "all" ? undefined : scope, period: q ? undefined : period || undefined, search: q || undefined, status: status || undefined, limit: 300 } }).then((r) => r.bookings),
  });
  const PERIODS: { id: Period; label: string }[] = [
    { id: "upcoming", label: t`À venir` },
    { id: "current", label: t`En cours` },
    { id: "past", label: t`Passées` },
    { id: "", label: t`Toutes` },
  ];
  const pill: Record<string, string> = { option: t`Option`, solde: t`Solde à encaisser`, soldee: t`Payée`, plat: t`Autre site`, annulee: t`Annulée` };
  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="head">
        <h1 className="title">
          <Trans>Réservations</Trans>
        </h1>
        <div className="tools">
          <DownloadButton path="/bookings.csv" query={{ property: scope === "all" ? undefined : scope }} filename="reservations.csv">
            {t`Exporter`}
          </DownloadButton>
          <Link className="btn" to="/reglages/import">
            {t`Importer depuis elloha`}
          </Link>
        </div>
      </div>
      <div className="filters">
        <TextInput
          className="search"
          size="md"
          leftSection={<IconSearch size={20} />}
          placeholder={t`Nom, mail, téléphone ou référence`}
          aria-label={t`Rechercher une réservation`}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          size="md"
          w={210}
          aria-label={t`État des réservations`}
          allowDeselect={false}
          value={status}
          onChange={(v) => setStatus(v ?? "")}
          data={[
            { value: "", label: t`Tous les états` },
            { value: "confirmed", label: t`Confirmées` },
            { value: "pending", label: t`Options en cours` },
            { value: "cancelled", label: t`Annulées` },
          ]}
        />
        <div className="chips" role="group" aria-label={t`Période`}>
          {PERIODS.map((p) => (
            <button key={p.id || "all"} type="button" className="chip" aria-pressed={!q && period === p.id} disabled={!!q} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {list.error ? <ErrorLine text={t`La liste n'a pas pu être lue. Réessayez.`} /> : null}
      {list.isLoading ? <p className="loading">{t`Chargement…`}</p> : null}
      {list.data && list.data.length === 0 ? (
        <div className="empty">
          <h3>{q ? t`Aucune réservation ne correspond à « ${q} »` : t`Aucune réservation sur cette période`}</h3>
          <p>{q ? t`Essayez le nom de famille seul, ou la référence (par exemple PM-2026-012).` : t`Choisissez une autre période, ou faites une nouvelle vente depuis le calendrier.`}</p>
        </div>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="panel">
          {list.data.map((b) => {
            const st = bookingState(b);
            const balance = b.totalCents - b.paidCents;
            return (
              <button key={b.id} type="button" className="list-row" onClick={() => openBooking(b.id)}>
                <span>
                  <b>{b.guestName || channelName(b)}</b>
                  <small>{b.reference}</small>
                </span>
                <span className="hide-s">
                  {b.unitName}
                  <small>{stayRange(b.checkin, b.checkout)}</small>
                </span>
                <span className="hide-s">
                  <span className={`pill ${st}`}>{pill[st]}</span>
                </span>
                <span style={{ textAlign: "right" }}>
                  <b>{st === "plat" ? t`sur ${channelName(b)}` : eur(b.totalCents)}</b>
                  <small>{st === "solde" ? t`reste ${eur(balance)}` : ""}</small>
                  <small className="sr">{stayRange(b.checkin, b.checkout)}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
