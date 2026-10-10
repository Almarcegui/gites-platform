// Réglages : tout ce qui ne sert pas tous les jours, rangé par sujet. Chaque
// ligne ouvre un écran du nouveau back-office ; l'ancien /admin/ n'est plus
// nécessaire. En bas, ce qui ne regarde que cet appareil : clair ou sombre,
// domaine affiché, déconnexion.
import { Trans, useLingui } from "@lingui/react/macro";
import { useMantineColorScheme } from "@mantine/core";
import { IconCheck, IconChevronRight, IconLogout, IconMoon, IconSun } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { currentUser, logout } from "../api/client";
import { useProperties } from "../api/hooks";
import { useScope } from "../lib/scope";

interface Entry {
  to: string;
  label: string;
  hint: string;
}

export function SettingsPage() {
  const { t } = useLingui();
  const { data: properties = [] } = useProperties();
  const { scope, setScope } = useScope();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dark = colorScheme === "dark";

  const groups: { title: string; items: Entry[] }[] = [
    {
      title: t`Prix et ventes`,
      items: [
        { to: "/reglages/tarifs", label: t`Prix et saisons`, hint: t`Prix de base, saisons, prix fixés à la main, l'année en couleurs` },
        { to: "/reglages/promotions", label: t`Remises et codes promo`, hint: t`Long séjour, réservation tôt ou tardive, codes pour votre site` },
        { to: "/reglages/options", label: t`Options payantes`, hint: t`Sauna, bain chaud, linge, petit-déjeuner…` },
      ],
    },
    {
      title: t`Clients et argent`,
      items: [
        { to: "/reglages/clients", label: t`Clients`, hint: t`Coordonnées et séjours de chaque client` },
        { to: "/reglages/paiements", label: t`Paiements reçus`, hint: t`Tout ce qui a été encaissé ou attendu` },
        { to: "/reglages/chiffres", label: t`Chiffres de l'année`, hint: t`Remplissage, revenus, comparaison avec l'an passé, exports` },
        { to: "/reglages/modeles", label: t`Modèles de réponse`, hint: t`Les textes tout prêts pour répondre aux clients : accès, horaires, solde, après le séjour` },
      ],
    },
    {
      title: t`Airbnb, Booking et calendriers`,
      items: [
        { to: "/reglages/plateformes", label: t`Airbnb, Booking et Vrbo`, hint: t`La liaison avec les plateformes, leurs réservations, leurs prix` },
        { to: "/reglages/plateformes/prix", label: t`Promotions Airbnb et prix par plateforme`, hint: t`Remises long séjour, réservation tôt, dernière minute ; un prix propre à chaque plateforme` },
        { to: "/reglages/calendriers", label: t`Calendriers reliés`, hint: t`Adresses à donner aux autres sites, calendriers à lire` },
      ],
    },
    {
      title: t`Le domaine`,
      items: [
        { to: "/reglages/domaine", label: t`Le domaine et les biens`, hint: t`Coordonnées, horaires, arrhes, taxe de séjour, mails, conditions, biens` },
        { to: "/reglages/registre", label: t`Registre des voyageurs`, hint: t`Personnes hébergées, export pour la police` },
        { to: "/reglages/import", label: t`Importer depuis elloha`, hint: t`Reprendre des réservations d'un fichier` },
        { to: "/reglages/mise-en-route", label: t`Mise en route`, hint: t`Démarches légales et techniques, où on en est` },
      ],
    },
    {
      title: t`Accès et suivi`,
      items: [
        { to: "/reglages/mon-compte", label: t`Mon compte`, hint: t`Changer mon mot de passe` },
        { to: "/reglages/comptes", label: t`Personnes qui ont accès`, hint: t`Créer un accès, changer un mot de passe, couper un accès` },
        { to: "/reglages/journaux", label: t`Journaux`, hint: t`Qui a fait quoi, mails envoyés aux clients` },
      ],
    },
  ];

  return (
    <div className="pg" style={{ maxWidth: 820 }}>
      <div className="head">
        <h1 className="title">
          <Trans>Réglages</Trans>
        </h1>
      </div>
      <p className="lead">
        <Trans>Ce qui se règle de temps en temps. Le quotidien reste dans le menu : Aujourd'hui, Calendrier, Réservations, Messages, Ménage.</Trans>
      </p>
      {groups.map((g) => (
        <section key={g.title} className="blk">
          <h2 className="sub">{g.title}</h2>
          <nav className="idx" aria-label={g.title}>
            {g.items.map((e) => (
              <Link key={e.to} to={e.to}>
                <span>
                  <b>{e.label}</b>
                  <small>{e.hint}</small>
                </span>
                <IconChevronRight size={22} />
              </Link>
            ))}
          </nav>
        </section>
      ))}

      <section className="blk">
        <h2 className="sub">
          <Trans>Cet appareil</Trans>
        </h2>
        <div className="idx">
          <div className="row-set">
            <span>
              <b>
                <Trans>Affichage</Trans>
              </b>
              <small>
                <Trans>Retenu sur cet appareil seulement.</Trans>
              </small>
            </span>
            <div className="seg" role="group" aria-label={t`Affichage clair ou sombre`} style={{ margin: 0 }}>
              <button type="button" aria-pressed={!dark} onClick={() => setColorScheme("light")}>
                <IconSun size={20} /> <Trans>Clair</Trans>
              </button>
              <button type="button" aria-pressed={dark} onClick={() => setColorScheme("dark")}>
                <IconMoon size={20} /> <Trans>Sombre</Trans>
              </button>
            </div>
          </div>
          <p className="daily">
            <Trans>Domaine montré par l'écran</Trans>
          </p>
          {[{ id: "all" as const, name: t`Tous mes gîtes` }, ...properties.map((p) => ({ id: p.id, name: p.name }))].map((p) => (
            <button key={String(p.id)} type="button" className="link-row" aria-pressed={scope === p.id} onClick={() => setScope(p.id)}>
              <span>
                <b>{p.name}</b>
              </span>
              {scope === p.id ? <IconCheck size={22} style={{ marginLeft: "auto", color: "var(--pine-ink)" }} /> : null}
            </button>
          ))}
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
              <small>{t`Connecté en tant que ${currentUser() ?? "?"}`}</small>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
