// Avertissements non bloquants d'un devis (POST /quote du back-office) : le
// délai minimum du site public n'est pas tenu (l'exploitant peut passer outre,
// la vente est tracée au journal) ou le code de réduction saisi ne vaut rien.
import { useLingui } from "@lingui/react/macro";
import { IconAlertTriangle } from "@tabler/icons-react";

import type { Quote } from "../api/types";

export function QuoteWarnings({ quote }: { quote: Quote | undefined }) {
  const { t } = useLingui();
  const lines: string[] = [];
  if (quote?.warnings?.includes("lead_time")) {
    const n = quote.minLeadDays ?? 0;
    lines.push(
      n > 1
        ? t`Le site public refuserait cette arrivée : il faut réserver au moins ${n} jours avant. Vous pouvez l'enregistrer quand même, la vente sera notée au journal.`
        : t`Le site public refuserait cette arrivée : il faut réserver au plus tard la veille. Vous pouvez l'enregistrer quand même, la vente sera notée au journal.`,
    );
  }
  if (quote?.warnings?.includes("promo_invalid")) lines.push(t`Ce code de réduction n'est pas valable : il n'est pas appliqué au prix.`);
  if (!lines.length) return null;
  return (
    <>
      {lines.map((l) => (
        <p key={l} className="warn-line" role="status">
          <IconAlertTriangle size={20} />
          {l}
        </p>
      ))}
    </>
  );
}
