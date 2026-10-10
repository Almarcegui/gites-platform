// Import elloha : coller l'export des réservations futures, tester d'abord
// (rien n'est écrit), puis importer. Mêmes garde-fous anti-doublon et
// anti-conflit que le reste de la plateforme.
import { useLingui } from "@lingui/react/macro";
import { Textarea } from "@mantine/core";
import { useEffect, useState } from "react";

import { api } from "../../api/client";
import type { ImportResult } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { Page, Section, UnsavedGuard, useWorkingProperty } from "../../ui/kit";

export function ImportPage() {
  const { t } = useLingui();
  const [csv, setCsvRaw] = useState("");
  const [imported, setImported] = useState(false);
  // Le domaine ne change pas tant qu'un texte attend : l'import vise le domaine testé.
  const { property, picker } = useWorkingProperty(csv.trim().length > 0 && !imported);
  const [res, setRes] = useState<ImportResult | null>(null);
  // Un test vaut pour un texte ET un domaine : changer l'un ou l'autre l'efface.
  const [tested, setTested] = useState<{ csv: string; propertyId: number } | null>(null);
  const setCsv = (v: string) => {
    setCsvRaw(v);
    setRes(null);
    setTested(null);
    setImported(false);
  };
  // Après un import, changer de domaine repart d'une page vierge.
  const pid = property?.id;
  useEffect(() => {
    setCsvRaw("");
    setRes(null);
    setTested(null);
    setImported(false);
  }, [pid]);
  const testOk = !!tested && !!property && tested.csv === csv && tested.propertyId === property.id;
  const a = useAction();
  const run = (dryRun: boolean) =>
    a.run(
      async () => {
        const r = await api<{ result: ImportResult }>("/import/elloha", { method: "POST", query: { property: property?.id }, body: { csv, dryRun } });
        setRes(r.result);
        if (dryRun) setTested({ csv, propertyId: property!.id });
        else {
          setTested(null);
          setImported(true);
        }
        return r.result;
      },
      (r) => {
        const x = r as ImportResult;
        return dryRun ? t`Test terminé : ${x.imported} prête(s), ${x.conflicts} en conflit, ${x.skipped} déjà là, ${x.errors} erreur(s). Rien n'a été écrit.` : t`C'est fait. ${x.imported} réservation(s) importée(s).`;
      },
    );
  const word = (s: string) => ({ importé: t`importée`, ok_simulé: t`prête`, conflit: t`dates déjà prises`, déjà_importé: t`déjà là`, erreur: t`erreur` })[s] ?? s;
  const tone = (s: string) => (s === "importé" || s === "ok_simulé" ? "soldee" : s === "déjà_importé" ? "muted-pill" : "annulee");
  return (
    <Page title={t`Importer depuis elloha`} back tools={picker} lead={property ? t`Vers ${property.name}. Collez l'export des réservations à venir (une ligne par réservation, colonnes unite, arrivee, depart, nom, prenom, email, telephone, adultes, enfants, total, paye, reference).` : undefined}>
      <UnsavedGuard dirty={csv.trim().length > 0 && !imported} />
      <Section title={t`1. Coller le fichier`}>
        <Textarea size="md" autosize minRows={8} maxRows={20} aria-label={t`Contenu du fichier elloha`} placeholder="unite;arrivee;depart;nom;…" value={csv} onChange={(e) => setCsv(e.currentTarget.value)} styles={{ input: { fontFamily: "ui-monospace, monospace", fontSize: 14 } }} />
      </Section>
      <Section title={t`2. Tester, puis importer`} hint={t`Le test ne change rien. L'import n'est possible qu'après un test du même texte.`}>
        <div className="acts">
          <button type="button" className="btn" disabled={!csv.trim() || !property || a.state.status === "busy"} onClick={() => void run(true)}>
            {a.state.status === "busy" ? t`Un instant…` : t`Tester`}
          </button>
          <button type="button" className="btn pri" disabled={!testOk || !res || res.imported === 0 || a.state.status === "busy"} onClick={() => void run(false)}>
            {t`Importer pour de bon`}
          </button>
        </div>
        {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
        {res ? (
          <table className="tbl" style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>{t`Ligne`}</th>
                <th>{t`Résultat`}</th>
                <th>{t`Détail`}</th>
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.line}</td>
                  <td>
                    <span className={`pill ${tone(r.status)}`}>{word(r.status)}</span>
                  </td>
                  <td>{[r.reference, r.message].filter(Boolean).join(" : ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
    </Page>
  );
}
