// Réglages › Comptes › Accès de service (PR #105, repris de l'ancien écran) :
// les clés d'API de Claude et des scripts du Mac, sans compte humain. La clé
// n'est affichée qu'une fois, à la création ; seule son empreinte est gardée.
// Création et révocation : session humaine seulement (le serveur le vérifie).
import { Trans, useLingui } from "@lingui/react/macro";
import { TextInput } from "@mantine/core";
import { IconCopy, IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import type { ServiceKey } from "../../api/types2";
import { ErrorLine, useAction } from "../../lib/action";
import { useToast } from "../../lib/toasts";
import { Box, Confirm, Loading, Section, sqlWhen } from "../../ui/kit";

export function ServiceKeysSection() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["service-keys"], queryFn: () => api<{ keys: ServiceKey[] }>("/service-keys").then((r) => r.keys) });
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<ServiceKey | null>(null);
  const revoke = useAction();
  const active = (q.data ?? []).filter((k) => !k.revokedAt).length;
  return (
    <Section
      title={t`Accès de service`}
      id="h-svc"
      hint={t`Pour Claude et les scripts du Mac, sans compte humain : mêmes droits qu'un compte, présentés en « Authorization: Bearer svc:<clé> ». La clé n'est affichée qu'une fois ; une clé révoquée cesse de fonctionner tout de suite.`}
      tools={
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <IconPlus size={18} />
          <Trans>Créer une clé</Trans>
        </button>
      }
    >
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorLine text={t`Les clés n'ont pas pu être lues.`} /> : null}
      {q.data && q.data.length === 0 ? <p className="muted">{t`Aucune clé pour l'instant.`}</p> : null}
      {q.data && q.data.length > 0 ? (
        <div className="tbl-wrap">
          <table className="tbl dense">
            <caption className="sr">{t`Clés de service, ${active} active(s)`}</caption>
            <thead>
              <tr>
                <th scope="col">{t`Nom`}</th>
                <th scope="col">{t`État`}</th>
                <th scope="col">{t`Créée`}</th>
                <th scope="col">{t`Dernier usage`}</th>
                <th scope="col" className="r">
                  <span className="sr">{t`Action`}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((k) => (
                <tr key={k.id}>
                  <td>
                    <b>{k.name}</b>
                    <small className="mono-line">{k.keyHint}</small>
                  </td>
                  <td>
                    <span className={`pill ${k.revokedAt ? "annulee" : "soldee"}`}>{k.revokedAt ? t`révoquée` : t`active`}</span>
                  </td>
                  <td>
                    {sqlWhen(k.createdAt)}
                    {k.createdBy ? <small>{t`par ${k.createdBy}`}</small> : null}
                  </td>
                  <td>{k.lastUsedAt ? sqlWhen(k.lastUsedAt) : t`jamais`}</td>
                  <td className="r">
                    {k.revokedAt ? null : (
                      <button type="button" className="btn danger" onClick={() => setRevoking(k)}>
                        {t`Révoquer`}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <AddKeyBox open={adding} onClose={() => setAdding(false)} onCreated={(r) => setShown(r)} />
      <Box open={shown != null} onClose={() => setShown(null)} title={t`Clé créée`} size="md">
        {shown ? <ShownKey name={shown.name} value={shown.key} /> : null}
        <div className="acts" style={{ marginTop: 16 }}>
          <button type="button" className="btn pri" onClick={() => setShown(null)}>
            <Trans>J'ai copié la clé</Trans>
          </button>
        </div>
      </Box>
      <Confirm
        open={revoking != null}
        title={t`Révoquer la clé « ${revoking?.name ?? ""} » ?`}
        text={t`Ce qui l'utilise cessera de fonctionner immédiatement.`}
        yes={t`Révoquer la clé`}
        danger
        busy={revoke.state.status === "busy"}
        onYes={async () => {
          const k = revoking;
          if (!k) return;
          if (await revoke.run(() => api(`/service-keys/${k.id}/revoke`, { method: "POST" }), t`C'est fait. Clé révoquée.`)) {
            setRevoking(null);
            await qc.invalidateQueries({ queryKey: ["service-keys"] });
          }
        }}
        onNo={() => setRevoking(null)}
      >
        {revoke.state.status === "error" ? <ErrorLine text={revoke.state.text} /> : null}
      </Confirm>
    </Section>
  );
}

function ShownKey({ name, value }: { name: string; value: string }) {
  const { t } = useLingui();
  const toast = useToast();
  return (
    <>
      <p className="lead">{t`Clé « ${name} », affichée une seule fois. À coller dans ~/.config/gites/service.env (GITES_SERVICE_KEY).`}</p>
      <p className="secret">{value}</p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          toast(t`C'est fait. Clé copiée.`);
        }}
      >
        <IconCopy size={18} />
        <Trans>Copier</Trans>
      </button>
    </>
  );
}

function AddKeyBox({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: { name: string; key: string }) => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const a = useAction();
  const clean = name.trim().toLowerCase();
  const ok = /^[a-z0-9._-]{2,40}$/.test(clean);
  return (
    <Box open={open} onClose={onClose} title={t`Créer une clé de service`} size="md">
      <TextInput label={t`Nom de la clé`} description={t`2 à 40 caractères : lettres minuscules, chiffres, point, tiret, tiret bas. Par exemple : claude-mac, script-sauvegarde`} value={name} onChange={(e) => setName(e.currentTarget.value)} autoCapitalize="none" spellCheck={false} />
      {a.state.status === "error" ? <ErrorLine text={a.state.text} /> : null}
      <div className="acts" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn pri"
          disabled={!ok || a.state.status === "busy"}
          onClick={async () => {
            let r: { key: string; serviceKey: ServiceKey } | null = null;
            const done = await a.run(async () => {
              r = await api<{ key: string; serviceKey: ServiceKey }>("/service-keys", { method: "POST", body: { name: clean } });
              return r;
            }, t`C'est fait. Clé créée.`);
            if (done && r) {
              const created = r as { key: string; serviceKey: ServiceKey };
              setName("");
              onClose();
              onCreated({ name: created.serviceKey.name, key: created.key });
              await qc.invalidateQueries({ queryKey: ["service-keys"] });
            }
          }}
        >
          {a.state.status === "busy" ? t`Un instant…` : t`Créer la clé`}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          <Trans>Annuler</Trans>
        </button>
      </div>
    </Box>
  );
}
