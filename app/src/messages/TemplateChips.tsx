// « Partir d'un modèle » : les modèles de réponse de la base (Réglages ›
// Modèles de réponse), en puces. Partagé par Messages et la fiche réservation.
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useTemplates } from "../api/hooks";
import { ErrorLine } from "../lib/action";
import { fillTemplate, type TemplateContext } from "../lib/templates";

export function TemplateChips({ propertyId, ctx, onPick, labelId }: { propertyId: number | null | undefined; ctx: TemplateContext; onPick: (text: string) => void; labelId?: string }) {
  const { t } = useLingui();
  const q = useTemplates(propertyId);
  const [picked, setPicked] = useState<number | null>(null);
  const list = q.data ?? [];
  return (
    <>
      <p className="tpl" id={labelId ?? "tpl-l"}>
        <Trans>Partir d'un modèle</Trans>
      </p>
      {q.error ? <ErrorLine text={t`Les modèles n'ont pas pu être lus. Vous pouvez écrire sans.`} /> : null}
      <div className="chips" role="group" aria-labelledby={labelId ?? "tpl-l"}>
        {list.map((m) => (
          <button
            key={m.id}
            type="button"
            className="chip"
            aria-pressed={picked === m.id}
            onClick={() => {
              setPicked(m.id);
              onPick(fillTemplate(m.body, ctx));
            }}
          >
            {m.name}
            {m.lang !== "fr" ? ` (${m.lang.toUpperCase()})` : ""}
          </button>
        ))}
        {q.data && list.length === 0 ? (
          <span className="muted">
            {t`Aucun modèle.`} <Link to="/reglages/modeles">{t`En écrire un`}</Link>
          </span>
        ) : null}
      </div>
    </>
  );
}
