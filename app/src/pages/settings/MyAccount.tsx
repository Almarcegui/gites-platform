// Mon compte (lot 2, point 4) : changer son propre mot de passe. L'ancien est
// exigé ; les autres appareils connectés à ce compte sont déconnectés, celui-ci
// reste connecté.
import { Trans, useLingui } from "@lingui/react/macro";
import { PasswordInput } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { ErrorLine, useAction } from "../../lib/action";
import { useToast } from "../../lib/toasts";
import { Box, Loading, Page, Section, sqlWhen } from "../../ui/kit";

interface Me {
  user: string;
  kind: "compte" | "secours";
  sessions: number;
  lastLoginAt?: string | null;
}

export function MyAccountPage() {
  const { t } = useLingui();
  const toast = useToast();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me") });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const a = useAction();
  const gen = useAction();
  const mismatch = again.length > 0 && again !== next;
  const tooShort = next.length > 0 && next.length < 12;
  const valid = current.length > 0 && next.length >= 12 && next === again;
  const others = Math.max(0, (me.data?.sessions ?? 1) - 1);
  const reset = () => {
    setCurrent("");
    setNext("");
    setAgain("");
  };
  return (
    <Page title={t`Mon compte`} back width={720} lead={t`Votre mot de passe à vous. Pour donner ou couper l'accès à quelqu'un d'autre, c'est dans « Personnes qui ont accès ».`}>
      {me.isLoading ? <Loading /> : null}
      {me.error ? <ErrorLine text={t`Le compte n'a pas pu être lu.`} /> : null}
      {me.data ? (
        <Section title={t`Connecté en tant que ${me.data.user}`} hint={me.data.kind === "compte" ? (others > 0 ? t`Ce compte est aussi ouvert sur ${others} autre(s) appareil(s). Changer le mot de passe les déconnecte.` : t`Ce compte n'est ouvert que sur cet appareil.`) + (me.data.lastLoginAt ? ` ${t`Dernière connexion : ${sqlWhen(me.data.lastLoginAt)}.`}` : "") : undefined}>
          {me.data.kind === "secours" ? (
            <ErrorLine text={t`Vous êtes entré avec l'accès de secours du serveur : ce mot de passe-là se change dans la configuration du serveur, pas ici. Créez-vous un compte dans « Personnes qui ont accès ».`} />
          ) : (
            <div style={{ maxWidth: 420 }}>
              <PasswordInput size="md" label={t`Mot de passe actuel`} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.currentTarget.value)} />
              <PasswordInput mt="md" size="md" label={t`Nouveau mot de passe`} description={t`12 caractères au moins. Une phrase de quatre mots fait très bien l'affaire.`} autoComplete="new-password" error={tooShort ? t`Encore ${12 - next.length} caractère(s).` : undefined} value={next} onChange={(e) => setNext(e.currentTarget.value)} />
              <PasswordInput mt="md" size="md" label={t`Le nouveau, une seconde fois`} autoComplete="new-password" error={mismatch ? t`Les deux ne sont pas pareils.` : undefined} value={again} onChange={(e) => setAgain(e.currentTarget.value)} />
              {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
              <div className="acts" style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="btn pri"
                  disabled={!valid || a.state.status === "busy"}
                  onClick={async () => {
                    if (await a.run(() => api("/me/password", { method: "POST", body: { current, next } }), t`C'est fait. Mot de passe changé.`)) reset();
                  }}
                >
                  {a.state.status === "busy" ? t`Un instant…` : t`Changer mon mot de passe`}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!current || gen.state.status === "busy"}
                  title={t`La plateforme en choisit un pour vous, facile à dicter`}
                  onClick={async () => {
                    await gen.run(async () => {
                      const r = await api<{ password: string }>("/me/password", { method: "POST", body: { current, generate: true } });
                      setShown(r.password);
                      reset();
                      return r;
                    }, t`C'est fait. Nouveau mot de passe choisi.`);
                  }}
                >
                  {gen.state.status === "busy" ? t`Un instant…` : t`M'en proposer un`}
                </button>
              </div>
              {gen.state.status === "error" ? <ErrorLine text={gen.state.text} /> : null}
            </div>
          )}
        </Section>
      ) : null}
      <Box open={shown != null} onClose={() => setShown(null)} title={t`Votre nouveau mot de passe`} size="md" noClose>
        <p className="lead">{t`Il ne sera plus jamais affiché : notez-le maintenant. Cet appareil reste connecté.`}</p>
        <p className="secret">{shown}</p>
        <div className="acts" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn pri"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shown ?? "");
                toast(t`Mot de passe copié.`);
              } catch {
                toast(t`Copie impossible : recopiez-le à la main.`, true);
              }
            }}
          >
            <IconCopy size={20} />
            <Trans>Copier</Trans>
          </button>
          <button type="button" className="btn" onClick={() => setShown(null)}>
            <Trans>C'est noté, fermer</Trans>
          </button>
        </div>
      </Box>
    </Page>
  );
}
