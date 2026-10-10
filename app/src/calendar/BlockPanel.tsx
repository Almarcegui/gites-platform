// Dates bloquées à la main : la fiche du blocage en panneau latéral, d'où on
// le lève (l'ancien écran avait une croix sur la barre).
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { api } from "../api/client";
import type { ManualBlock } from "../api/types";
import { ErrorLine, useAction } from "../lib/action";
import { diffDays, stayRange } from "../lib/dates";
import { Confirm, SidePanel } from "../ui/kit";

export function BlockPanel({ block, unitName, onClose }: { block: ManualBlock; unitName: string; onClose: () => void }) {
  const { t } = useLingui();
  const [ask, setAsk] = useState(false);
  const a = useAction();
  const n = diffDays(block.checkin, block.checkout);
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Dates bloquées`}
      top={unitName}
      title={t`Bloqué ${stayRange(block.checkin, block.checkout)}`}
      actions={
        <button type="button" className="btn pri wide" onClick={() => setAsk(true)}>
          {t`Lever le blocage`}
        </button>
      }
    >
      <p className="lead">{block.reason ? t`Motif : ${block.reason}` : t`Pas de motif noté.`}</p>
      <p className="note">{n > 1 ? t`${n} nuits qui ne se vendent pas, ici ni sur les plateformes.` : t`1 nuit qui ne se vend pas, ici ni sur les plateformes.`}</p>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={ask}
        title={t`Lever le blocage ?`}
        text={t`Ces nuits redeviennent libres tout de suite, ici et sur Airbnb et Booking.`}
        yes={t`Lever le blocage`}
        busy={a.state.status === "busy"}
        onNo={() => setAsk(false)}
        onYes={async () => {
          const ok = await a.run(() => api(`/blocks/${block.id}`, { method: "DELETE" }), t`C'est fait. Les dates sont libres.`);
          setAsk(false);
          if (ok) onClose();
        }}
      />
    </SidePanel>
  );
}
