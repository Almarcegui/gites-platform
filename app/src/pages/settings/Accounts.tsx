// Personnes qui ont accès : un compte par personne, sa fiche en panneau
// latéral (nouveau mot de passe, couper ou rendre l'accès, supprimer). Le mot
// de passe est fabriqué par le serveur (« trois mots et un nombre », facile à
// dicter) et n'est montré qu'une fois.
import { Trans, useLingui } from "@lingui/react/macro";
import { TextInput } from "@mantine/core";
import { IconCopy, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api, currentUser } from "../../api/client";
import type { AdminUser } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { useToast } from "../../lib/toasts";
import { Box, Confirm, Loading, Page, Section, SidePanel, sqlWhen } from "../../ui/kit";

const isOn = (u: AdminUser) => u.active === true || u.active === 1;

export function AccountsPage() {
  const { t } = useLingui();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: AdminUser[] }>("/users").then((r) => r.users) });
  const [open, setOpen] = useState<AdminUser | null>(null);
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<{ username: string; password: string; created: boolean } | null>(null);
  return (
    <Page title={t`Personnes qui ont accès`} back lead={t`Chaque personne a son propre identifiant. Couper un accès est immédiat : la personne est déconnectée partout.`}>
      {q.error ? <ErrorLine text={t`Les comptes n'ont pas pu être lus.`} /> : null}
      {q.isLoading ? <Loading /> : null}
      {q.data ? (
        <Section
          title={q.data.length > 1 ? t`${q.data.length} comptes` : t`${q.data.length} compte`}
          tools={
            <button type="button" className="btn pri" onClick={() => setAdding(true)}>
              <IconPlus size={20} />
              <Trans>Donner un accès</Trans>
            </button>
          }
        >
          <div className="panel" role="list">
            {q.data.map((u) => (
              <button key={u.id} type="button" role="listitem" className={`list-row two${isOn(u) ? "" : " off"}`} onClick={() => setOpen(u)}>
                <span>
                  <b>
                    {u.username}
                    {u.username === currentUser() ? t` (vous)` : ""}
                  </b>
                  <small>{u.last_login_at ? t`dernière connexion le ${sqlWhen(u.last_login_at)}` : t`jamais connecté`}</small>
                </span>
                <span className={`pill ${isOn(u) ? "soldee" : "annulee"}`}>{isOn(u) ? t`accès ouvert` : t`accès coupé`}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      {open ? <AccountPanel u={open} onClose={() => setOpen(null)} onPassword={(p) => setShown({ ...p, created: false })} /> : null}
      <AddBox open={adding} onClose={() => setAdding(false)} onCreated={(p) => setShown({ ...p, created: true })} />
      <PasswordBox shown={shown} onClose={() => setShown(null)} />
    </Page>
  );
}

function AddBox({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: { username: string; password: string }) => void }) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const a = useAction();
  const clean = name.trim().toLowerCase();
  const ok = /^[a-z0-9][a-z0-9._-]{1,19}$/.test(clean);
  return (
    <Box open={open} onClose={onClose} title={t`Donner un accès`} size="md">
      <TextInput size="md" label={t`Identifiant`} description={t`2 à 20 lettres minuscules ou chiffres, sans espace (point et tiret permis). Par exemple : papa, marie.d`} value={name} onChange={(e) => setName(e.currentTarget.value)} autoCapitalize="none" />
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={!ok || a.state.status === "busy"}
          onClick={async () => {
            let created: { username: string; password: string } | null = null;
            const done = await a.run(async () => {
              created = await api<{ username: string; password: string }>("/users", { method: "POST", body: { username: clean } });
              return created;
            }, t`C'est fait. Compte ${clean} créé.`);
            if (done && created) {
              setName("");
              onClose();
              onCreated(created);
            }
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Créer le compte`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
    </Box>
  );
}

function PasswordBox({ shown, onClose }: { shown: { username: string; password: string; created: boolean } | null; onClose: () => void }) {
  const { t } = useLingui();
  const toast = useToast();
  return (
    <Box open={shown != null} onClose={onClose} title={shown?.created ? t`Compte créé` : t`Nouveau mot de passe`} size="md">
      <p className="lead">{t`Mot de passe de ${shown?.username ?? ""}. Il ne sera plus jamais affiché : notez-le ou transmettez-le maintenant.`}</p>
      <p className="secret">{shown?.password}</p>
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(shown?.password ?? "");
              toast(t`Mot de passe copié.`);
            } catch {
              toast(t`Copie impossible : recopiez-le à la main.`, true);
            }
          }}
        >
          <IconCopy size={20} />
          <Trans>Copier</Trans>
        </button>
        <button type="button" className="btn" onClick={onClose}>
          <Trans>C'est noté, fermer</Trans>
        </button>
      </div>
    </Box>
  );
}

function AccountPanel({ u, onClose, onPassword }: { u: AdminUser; onClose: () => void; onPassword: (p: { username: string; password: string }) => void }) {
  const { t } = useLingui();
  const [ask, setAsk] = useState<null | "reset" | "toggle" | "delete">(null);
  const a = useAction();
  const me = u.username === currentUser();
  const on = isOn(u);
  return (
    <SidePanel
      opened
      onClose={onClose}
      label={t`Compte`}
      top={t`Compte`}
      title={u.username}
      pill={<span className={`pill ${on ? "soldee" : "annulee"}`}>{on ? t`accès ouvert` : t`accès coupé`}</span>}
      actions={
        <>
          <button type="button" className="btn pri wide" onClick={() => setAsk("reset")}>
            {t`Donner un nouveau mot de passe`}
          </button>
          {!me ? (
            <button type="button" className="btn wide" onClick={() => setAsk("toggle")}>
              {on ? t`Couper l'accès` : t`Rendre l'accès`}
            </button>
          ) : null}
        </>
      }
      more={me ? [] : [{ label: t`Supprimer le compte`, danger: true, onClick: () => setAsk("delete") }]}
    >
      <dl className="facts">
        <div>
          <dt>{t`Dernière connexion`}</dt>
          <dd>{u.last_login_at ? sqlWhen(u.last_login_at) : t`jamais`}</dd>
        </div>
        <div>
          <dt>{t`Appareils connectés`}</dt>
          <dd>{u.sessions}</dd>
        </div>
        <div>
          <dt>{t`Créé le`}</dt>
          <dd>{sqlWhen(u.created_at)}</dd>
        </div>
      </dl>
      {me ? <p className="hint">{t`C'est votre compte : vous ne pouvez ni couper ni supprimer votre propre accès.`}</p> : null}
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <Confirm
        open={ask === "reset"}
        title={t`Nouveau mot de passe pour ${u.username} ?`}
        text={t`L'ancien cesse de marcher tout de suite, et ${u.username} est déconnecté de tous ses appareils.`}
        yes={t`Fabriquer un nouveau mot de passe`}
        busy={a.state.status === "busy"}
        onNo={() => setAsk(null)}
        onYes={async () => {
          let r: { username: string; password: string } | null = null;
          const ok = await a.run(async () => {
            r = await api<{ username: string; password: string }>(`/users/${u.id}/reset-password`, { method: "POST" });
            return r;
          }, t`C'est fait. Nouveau mot de passe prêt.`);
          setAsk(null);
          if (ok && r) {
            onClose();
            onPassword(r);
          }
        }}
      />
      <Confirm
        open={ask === "toggle"}
        title={on ? t`Couper l'accès de ${u.username} ?` : t`Rendre l'accès à ${u.username} ?`}
        text={on ? t`${u.username} est déconnecté tout de suite et ne peut plus entrer. Vous pourrez lui rendre l'accès plus tard.` : t`${u.username} pourra de nouveau se connecter avec son mot de passe.`}
        yes={on ? t`Couper l'accès` : t`Rendre l'accès`}
        danger={on}
        busy={a.state.status === "busy"}
        onNo={() => setAsk(null)}
        onYes={async () => {
          const ok = await a.run(() => api(`/users/${u.id}`, { method: "PATCH", body: { active: !on } }), on ? t`C'est fait. Accès coupé.` : t`C'est fait. Accès rendu.`);
          setAsk(null);
          if (ok) onClose();
        }}
      />
      <Confirm
        open={ask === "delete"}
        title={t`Supprimer le compte ${u.username} ?`}
        text={t`Le compte disparaît. Pour une absence, coupez plutôt l'accès : il se rend en un geste.`}
        yes={t`Supprimer le compte`}
        danger
        busy={a.state.status === "busy"}
        onNo={() => setAsk(null)}
        onYes={async () => {
          const ok = await a.run(() => api(`/users/${u.id}`, { method: "DELETE" }), t`C'est fait. Compte supprimé.`);
          setAsk(null);
          if (ok) onClose();
        }}
      />
    </SidePanel>
  );
}
