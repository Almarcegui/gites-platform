// Cet appareil : clair ou sombre, langue, domaine montré, déconnexion. Ce qui
// ne regarde que ce navigateur (localStorage). Affiché en bas de Réglages et
// sur sa propre page (barre latérale › Réglages › Cet appareil).
import { Trans, useLingui } from "@lingui/react/macro";
import { useMantineColorScheme } from "@mantine/core";
import { IconCheck, IconLogout, IconMoon, IconSun } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { currentUser, logout } from "../../api/client";
import { useProperties } from "../../api/hooks";
import { setLocale } from "../../i18n";
import { useScope } from "../../lib/scope";
import { Page } from "../../ui/kit";

export function DeviceSettings() {
  const { t, i18n } = useLingui();
  const { data: properties = [] } = useProperties();
  const { scope, setScope } = useScope();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dark = colorScheme === "dark";
  return (
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
      <div className="row-set">
        <span>
          <b>
            <Trans>Langue</Trans>
          </b>
          <small>
            <Trans>Retenu sur cet appareil seulement. Sans choix, l'écran suit la langue du navigateur.</Trans>
          </small>
        </span>
        {/* Chaque langue s'écrit dans sa propre langue : on la reconnaît même sans la lire. */}
        <div className="seg" role="group" aria-label={t`Langue de l'écran`} style={{ margin: 0 }}>
          <button type="button" lang="fr" aria-pressed={i18n.locale === "fr"} onClick={() => setLocale("fr")}>
            Français
          </button>
          <button type="button" lang="nl" aria-pressed={i18n.locale === "nl"} onClick={() => setLocale("nl")}>
            Nederlands
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
  );
}

export function DevicePage() {
  const { t } = useLingui();
  return (
    <Page title={t`Cet appareil`} back lead={t`Ce qui se règle ici ne vaut que pour ce navigateur.`} width={820}>
      <DeviceSettings />
    </Page>
  );
}
