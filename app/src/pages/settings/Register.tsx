// Registre des voyageurs : la saisie se fait sur la fiche de chaque
// réservation, à l'arrivée ; ici, l'export d'une période (la seule sortie de
// ces données, sur demande d'une autorité).
import { useLingui } from "@lingui/react/macro";
import { TextInput } from "@mantine/core";
import { useState } from "react";

import { ErrorLine } from "../../lib/action";
import { addDays, diffDays, todayBrussels } from "../../lib/dates";
import { useScope } from "../../lib/scope";
import { DownloadButton, Page, Section } from "../../ui/kit";

export function RegisterPage() {
  const { t } = useLingui();
  const { scope } = useScope();
  const today = todayBrussels();
  const [from, setFrom] = useState(addDays(today, -365));
  const [to, setTo] = useState(today);
  const ok = !!from && !!to && from <= to;
  return (
    <Page title={t`Registre des voyageurs`} back lead={t`La loi demande de noter chaque personne hébergée. La saisie se fait à l'arrivée, dans la fiche de la réservation (« Voyageurs inscrits »).`}>
      <Section title={t`Exporter une période`} hint={t`Un fichier tableur avec les personnes dont le séjour croise ces dates${scope === "all" ? "" : ", pour le domaine affiché"}. L'export est noté dans le journal.`}>
        <div className="grid2" style={{ maxWidth: 520 }}>
          <TextInput size="md" type="date" label={t`Du`} value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <TextInput size="md" type="date" label={t`Au`} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        </div>
        {!ok ? <ErrorLine text={t`La fin doit venir après le début.`} /> : <p className="hint">{t`${diffDays(from, to) + 1} jours.`}</p>}
        <div className="acts">{ok ? <DownloadButton path="/guest-register.csv" query={{ from, to, property: scope === "all" ? undefined : scope }} filename={`registre-${from}_${to}.csv`}>{t`Exporter le registre`}</DownloadButton> : null}</div>
      </Section>
      <Section title={t`Comment le registre est tenu`}>
        <ul className="plain-list">
          <li>{t`Une ligne enregistrée ne se modifie pas : une correction ajoute une ligne qui remplace l'ancienne.`}</li>
          <li>{t`Les lignes s'effacent toutes seules à la fin de la durée de conservation.`}</li>
          <li>{t`Ces données ne sortent par aucun autre chemin que cet export.`}</li>
        </ul>
      </Section>
    </Page>
  );
}
