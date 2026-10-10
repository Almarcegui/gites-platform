import { Trans, useLingui } from "@lingui/react/macro";
import { PasswordInput, TextInput } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { errorText, lastUser, login } from "../api/client";
import { ErrorLine } from "../lib/action";

export function LoginPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [user, setUser] = useState(lastUser());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(user.trim(), password);
            qc.clear();
            await navigate({ to: "/" });
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>
          <Trans>Gestion des gîtes</Trans>
        </h1>
        <p>
          <Trans>Connectez-vous avec le même identifiant que d'habitude.</Trans>
        </p>
        <TextInput label={t`Identifiant`} size="md" autoComplete="username" value={user} onChange={(e) => setUser(e.currentTarget.value)} required />
        <PasswordInput label={t`Mot de passe`} size="md" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} required />
        <button className="btn pri" type="submit" disabled={busy}>
          {busy ? t`Un instant…` : t`Se connecter`}
        </button>
        {error ? <ErrorLine text={error} /> : null}
        <span className="pilot">
          <Trans>Nouvel écran, en essai</Trans>
        </span>
      </form>
    </div>
  );
}
