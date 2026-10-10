// Réglages, pour le pilote : le domaine affiché, et le chemin vers l'ancien
// écran pour tout ce qui se règle une fois pour toutes.
import { Trans, useLingui } from "@lingui/react/macro";
import { IconCheck, IconChevronRight, IconExternalLink, IconLogout } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { currentUser, logout } from "../api/client";
import { useProperties } from "../api/hooks";
import { useScope } from "../lib/scope";

export function SettingsPage() {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const { scope, setScope } = useScope();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const old = [
    { href: "/admin/#/params", label: t`Mes biens, mes prix et les règles de paiement`, hint: t`Domaine, hébergements, saisons, arrhes, horaires` },
    { href: "/admin/#/promos", label: t`Codes de réduction`, hint: t`Remises et codes pour votre site` },
    { href: "/admin/#/options", label: t`Options payantes`, hint: t`Sauna, bain chaud, linge…` },
    { href: "/admin/#/canaux", label: t`Airbnb et Booking`, hint: t`La liaison avec les plateformes` },
    { href: "/admin/#/ical", label: t`Calendriers d'autres sites`, hint: t`Les calendriers reliés` },
    { href: "/admin/#/users", label: t`Personnes qui ont accès`, hint: t`Comptes et mots de passe` },
    { href: "/admin/#/stats", label: t`Chiffres de l'année`, hint: t`Nuits vendues, revenus` },
  ];
  return (
    <div style={{ maxWidth: 760, display: "grid", gap: 20 }}>
      <div className="head">
        <h1 className="title">
          <Trans>Réglages</Trans>
        </h1>
      </div>
      <nav className="idx" aria-label={t`Domaine affiché`}>
        <p className="daily">
          <Trans>Le menu garde l'essentiel de tous les jours. Ici, choisissez d'abord le domaine que l'écran montre.</Trans>
        </p>
        {[{ id: "all" as const, name: t`Tous mes gîtes` }, ...properties.map((p) => ({ id: p.id, name: p.name }))].map((p) => (
          <button key={String(p.id)} type="button" className="link-row" aria-pressed={scope === p.id} onClick={() => setScope(p.id)}>
            <span>
              <b>{p.name}</b>
            </span>
            {scope === p.id ? <IconCheck size={22} style={{ marginLeft: "auto", color: "var(--pine-ink)" }} /> : null}
          </button>
        ))}
      </nav>
      <nav className="idx" aria-label={t`Réglages dans l'ancien écran`}>
        <p className="daily">
          <Trans>Pendant l'essai, ce qui se règle une fois pour toutes reste dans l'ancien écran. Il s'ouvre avec la même connexion.</Trans>
        </p>
        {old.map((o) => (
          <a key={o.href} href={o.href}>
            <IconExternalLink size={22} />
            <span>
              {o.label}
              <small>{o.hint}</small>
            </span>
            <IconChevronRight size={22} />
          </a>
        ))}
      </nav>
      <div className="idx">
        <p className="daily">{t`Connecté en tant que ${currentUser() ?? "?"}. Le mode sombre suit celui du téléphone ou de l'ordinateur.`}</p>
        <button
          type="button"
          className="link-row"
          onClick={async () => {
            await logout();
            qc.clear();
            await navigate({ to: "/connexion" });
          }}
        >
          <IconLogout size={22} />
          <span>
            <b>
              <Trans>Se déconnecter</Trans>
            </b>
          </span>
        </button>
      </div>
    </div>
  );
}
