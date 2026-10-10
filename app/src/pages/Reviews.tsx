// Carte « Avis » d'Aujourd'hui (lot 3) : note moyenne des avis Airbnb et
// Booking relevés par Beds24, derniers avis, alerte pour un avis sous 4 sans
// réponse, lien vers Beds24 pour répondre (l'API ne permet pas d'y répondre
// d'ici). Rien ne s'affiche tant qu'aucun avis n'a été relevé.
import { useLingui } from "@lingui/react/macro";
import { IconAlertTriangle, IconExternalLink, IconStar } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { ReviewItem, ReviewsSummary } from "../api/types2";
import { longDate } from "../lib/dates";
import { useScope } from "../lib/scope";

const note = (n: number | null) => (n == null ? "—" : String(n).replace(".", ","));

export function useReviews() {
  const { scope } = useScope();
  return useQuery({
    queryKey: ["reviews", scope],
    queryFn: () => api<ReviewsSummary>("/reviews", { query: { property: scope === "all" ? undefined : scope } }),
    staleTime: 10 * 60_000,
  });
}

function useChannelLabel() {
  const { t } = useLingui();
  return (c: string) => (c === "airbnb" ? "Airbnb" : c === "booking" ? "Booking.com" : t`plateforme`);
}

function excerpt(r: ReviewItem): string {
  const s = r.headline || r.body || r.negative || "";
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}

/** À l'ordinateur : une ligne sous le bandeau du jour. */
export function ReviewsStrip() {
  const { t } = useLingui();
  const label = useChannelLabel();
  const q = useReviews();
  const s = q.data;
  if (!s || s.count === 0) return null;
  const last = s.latest[0];
  return (
    <section className="reviews-strip" aria-label={t`Avis`}>
      <span className="t-h">
        <IconStar size={22} />
        {t`Avis`}
      </span>
      <span className="score">{t`${note(s.average)} / 5`}</span>
      <span className="muted">{t`${s.count} avis`}{s.byChannel.length > 1 ? ` (${s.byChannel.map((c) => `${label(c.channel)} ${note(c.average)}`).join(" · ")})` : ""}</span>
      {last ? (
        <span className="last" title={excerpt(last)}>
          {t`Dernier, ${label(last.channel)} ${note(last.rating)} / 5 :`} « {excerpt(last)} »
        </span>
      ) : null}
      {s.low.length ? (
        <span className="low">
          <IconAlertTriangle size={18} /> {s.low.length > 1 ? t`${s.low.length} avis sous ${s.lowScore} sans réponse` : t`1 avis sous ${s.lowScore} sans réponse`}
        </span>
      ) : null}
      <a className="btn" href={s.replyUrl} target="_blank" rel="noopener noreferrer">
        <IconExternalLink size={20} />
        {t`Répondre dans Beds24`}
      </a>
    </section>
  );
}

/** Au téléphone : une carte dans « À régler sans heure fixe ». */
export function ReviewsCard() {
  const { t } = useLingui();
  const label = useChannelLabel();
  const q = useReviews();
  const s = q.data;
  if (!s || s.count === 0) return null;
  const shown = s.low.length ? s.low.slice(0, 2) : s.latest.slice(0, 2);
  return (
    <article className="card k-avis">
      <span className="kind">
        <IconStar size={22} />
        {t`Avis`}
      </span>
      <h3>{t`${note(s.average)} / 5 sur ${s.count} avis`}</h3>
      {s.low.length ? <p className="low">{s.low.length > 1 ? t`${s.low.length} avis sous ${s.lowScore} attendent une réponse.` : t`Un avis sous ${s.lowScore} attend une réponse.`}</p> : null}
      {shown.map((r) => (
        <p key={r.id} className="quote">
          {label(r.channel)}, {note(r.rating)} / 5{r.submittedAt ? `, ${longDate(r.submittedAt.slice(0, 10))}` : ""} : « {excerpt(r)} »
        </p>
      ))}
      <div className="row-b">
        <a className="btn pri" href={s.replyUrl} target="_blank" rel="noopener noreferrer">
          <IconExternalLink size={20} />
          {t`Répondre dans Beds24`}
        </a>
      </div>
    </article>
  );
}
