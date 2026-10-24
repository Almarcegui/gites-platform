// Fiche réservation : modifier les jours d'une option « à la date » (sauna, bain
// chaud). Mêmes contrôles que le tunnel : un seul client par jour pour tout le
// domaine. Les jours de cette réservation restent sélectionnables.
import { t } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api/client";
import type { Booking, QuoteLine } from "../api/types";
import { ErrorLine, useAction } from "../lib/action";
import { weekdayLong, shortDate } from "../lib/dates";

interface Avail {
  options: { id: number; days: { date: string; taken: boolean }[] }[];
}

export function OptionDays({ b, line }: { b: Booking; line: QuoteLine }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(line.days ?? []);
  const save = useAction();
  const q = useQuery({
    queryKey: ["option-days", b.id, b.unitId, b.checkin, b.checkout],
    enabled: open,
    queryFn: () => api<Avail>("/option-days", { query: { unitId: b.unitId, checkin: b.checkin, checkout: b.checkout, bookingId: b.id } }),
  });
  const days = q.data?.options.find((o) => o.id === line.optionId)?.days ?? [];
  const toggle = (d: string) => setPicked((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d].sort()));
  if (!open) {
    return (
      <button type="button" className="linkbtn" onClick={() => setOpen(true)}>
        {t`Modifier les jours`}
      </button>
    );
  }
  return (
    <div className="option-days">
      <div className="chips" role="group" aria-label={t`Jours de l'option`}>
        {days.map((d) => {
          const own = (line.days ?? []).includes(d.date);
          const blocked = d.taken && !own;
          return (
            <button
              key={d.date}
              type="button"
              className="chip"
              aria-pressed={picked.includes(d.date)}
              disabled={blocked}
              aria-label={`${weekdayLong(d.date)} ${shortDate(d.date)}${blocked ? ` - ${t`déjà réservé`}` : ""}`}
              onClick={() => toggle(d.date)}
            >
              {weekdayLong(d.date).slice(0, 3)} {shortDate(d.date)}
              {blocked ? ` · ${t`déjà réservé`}` : ""}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="btn"
        disabled={save.state.status === "busy" || picked.length === 0}
        onClick={async () => {
          if (await save.run(() => api(`/bookings/${b.id}`, { method: "PATCH", body: { optionDays: [{ id: line.optionId, days: picked }] } }), t`Jours enregistrés`)) setOpen(false);
        }}
      >
        {t`Enregistrer les jours`}
      </button>
      {save.state.status === "error" ? <ErrorLine text={save.state.text} /> : null}
    </div>
  );
}
