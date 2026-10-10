// Voyageurs inscrits (registre des personnes hébergées), dans la fiche de la
// réservation : la liste, la saisie à l'arrivée, la correction d'une ligne.
// Le registre est un journal : une correction ajoute une ligne qui remplace
// la précédente, rien ne s'efface à la main.
import { Trans, useLingui } from "@lingui/react/macro";
import { NumberInput, Select, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { Booking } from "../api/types";
import type { RegisterEntry, RegisterResponse } from "../api/types2";
import { ErrorLine, useAction } from "../lib/action";
import { Box } from "../ui/kit";

type Draft = Omit<RegisterEntry, "id" | "recordedBy" | "recordedAt" | "supersedesId" | "supersededById">;

function blank(r: RegisterResponse, first: boolean): Draft {
  return {
    lastName: first ? r.prefill.lastName : "",
    firstName: first ? r.prefill.firstName : "",
    birthDate: "",
    nationality: first ? r.prefill.nationality : "",
    idType: r.idTypes[0]?.value ?? "",
    idNumber: "",
    arrivalDate: r.prefill.arrivalDate,
    departureDate: r.prefill.departureDate,
  };
}

export function RegisterSection({ b }: { b: Booking }) {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["register", b.id], queryFn: () => api<RegisterResponse>(`/bookings/${b.id}/guest-register`) });
  const [adding, setAdding] = useState(false);
  const [fix, setFix] = useState<RegisterEntry | null>(null);
  if (q.isLoading) return <p className="note">{t`Lecture du registre…`}</p>;
  if (q.error || !q.data) return <ErrorLine text={t`Le registre n'a pas pu être lu.`} />;
  const r = q.data;
  const current = r.entries.filter((e) => e.supersededById == null);
  const label = (v: string) => r.idTypes.find((x) => x.value === v)?.label ?? v;
  return (
    <>
      {current.length === 0 ? <p className="note">{t`Personne n'est encore inscrit. La saisie se fait à l'arrivée, pièces d'identité en main.`}</p> : null}
      <ul className="occ">
        {current.map((e) => (
          <li key={e.id}>
            <span>
              <b>
                {e.firstName} {e.lastName}
              </b>
              <small>{t`né(e) le ${e.birthDate.split("-").reverse().join("/")}, ${e.nationality}, ${label(e.idType)} ${e.idNumber}`}</small>
            </span>
            {b.status !== "cancelled" ? (
              <button type="button" className="btn ghost" onClick={() => setFix(e)}>
                <Trans>Corriger</Trans>
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {b.status !== "cancelled" ? (
        <button type="button" className="btn" style={{ marginBottom: 14 }} onClick={() => setAdding(true)}>
          {current.length ? t`Inscrire d'autres voyageurs` : t`Inscrire les voyageurs`}
        </button>
      ) : null}
      <p className="note">{t`${current.length} personne(s) inscrite(s) sur ${r.prefill.occupants} attendue(s). Gardé ${r.retentionYears} ans, puis effacé tout seul.`}</p>
      {adding ? <EntryBox b={b} r={r} count={Math.max(1, r.prefill.occupants - current.length)} firstPrefill={current.length === 0} onClose={() => setAdding(false)} /> : null}
      {fix ? <EntryBox b={b} r={r} count={1} fix={fix} onClose={() => setFix(null)} /> : null}
    </>
  );
}

function EntryBox({ b, r, count, fix, firstPrefill, onClose }: { b: Booking; r: RegisterResponse; count: number; fix?: RegisterEntry; firstPrefill?: boolean; onClose: () => void }) {
  const { t } = useLingui();
  const [n, setN] = useState<number | string>(count);
  const [rows, setRows] = useState<Draft[]>(() => (fix ? [{ ...fix }] : Array.from({ length: count }, (_, i) => blank(r, !!firstPrefill && i === 0))));
  useEffect(() => {
    if (fix) return;
    const k = Math.max(1, Math.min(30, Number(n) || 1));
    setRows((cur) => (k > cur.length ? [...cur, ...Array.from({ length: k - cur.length }, () => blank(r, false))] : cur.slice(0, k)));
  }, [n, fix, r]);
  const a = useAction();
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const complete = rows.every((x) => x.lastName.trim() && x.firstName.trim() && x.birthDate && x.nationality.trim() && x.idNumber.trim() && x.arrivalDate && x.departureDate);
  return (
    <Box open onClose={onClose} title={fix ? t`Corriger une ligne du registre` : t`Inscrire les voyageurs — ${b.reference}`}>
      <p className="lead">{fix ? t`La ligne d'origine reste au registre ; la correction la remplace.` : t`Recopiez chaque pièce d'identité. Un enregistrement est définitif : une erreur se corrige ensuite par une nouvelle ligne.`}</p>
      {!fix ? <NumberInput size="md" w={220} label={t`Nombre de voyageurs`} min={1} max={30} value={n} onChange={setN} /> : null}
      {rows.map((x, i) => (
        <fieldset key={i} className="occ-f">
          <legend>{t`Voyageur ${i + 1}`}</legend>
          <div className="grid2">
            <TextInput size="md" label={t`Nom`} value={x.lastName} onChange={(e) => set(i, { lastName: e.currentTarget.value })} />
            <TextInput size="md" label={t`Prénom`} value={x.firstName} onChange={(e) => set(i, { firstName: e.currentTarget.value })} />
            <TextInput size="md" type="date" label={t`Date de naissance`} value={x.birthDate} onChange={(e) => set(i, { birthDate: e.currentTarget.value })} />
            <TextInput size="md" label={t`Nationalité`} value={x.nationality} onChange={(e) => set(i, { nationality: e.currentTarget.value })} />
            <Select size="md" label={t`Pièce d'identité`} allowDeselect={false} value={x.idType} onChange={(v) => set(i, { idType: v ?? x.idType })} data={r.idTypes} />
            <TextInput size="md" label={t`Numéro de la pièce`} value={x.idNumber} onChange={(e) => set(i, { idNumber: e.currentTarget.value })} />
            <TextInput size="md" type="date" label={t`Arrivée`} value={x.arrivalDate} onChange={(e) => set(i, { arrivalDate: e.currentTarget.value })} />
            <TextInput size="md" type="date" label={t`Départ`} value={x.departureDate} onChange={(e) => set(i, { departureDate: e.currentTarget.value })} />
          </div>
        </fieldset>
      ))}
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={!complete || a.state.status === "busy"}
          onClick={async () => {
            const entries = rows.map((x) => ({ ...x, lastName: x.lastName.trim(), firstName: x.firstName.trim(), nationality: x.nationality.trim(), idNumber: x.idNumber.trim(), supersedesId: fix?.id ?? null }));
            const ok = await a.run(() => api(`/bookings/${b.id}/guest-register`, { method: "POST", body: { entries } }), fix ? t`C'est fait. Correction enregistrée.` : t`C'est fait. ${entries.length} voyageur(s) inscrit(s) au registre.`);
            if (ok) onClose();
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : fix ? t`Enregistrer la correction` : t`Inscrire au registre`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
      {!complete ? <p className="hint">{t`Tous les champs sont demandés par la loi.`}</p> : null}
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}
