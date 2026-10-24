// « Liens du message » : sous chaque mail reçu, la liste des liens qu'il contient, SANS lien
// cliquable d'office. Le domaine réel en gras (c'est lui qui dit où mène le lien), l'adresse
// complète en petit, « Copier ». « Ouvrir » n'existe que si Gmail atteste l'expéditeur et que
// le message n'est pas usurpé (calculé par le serveur) ; il passe par une confirmation qui
// répète le domaine réel.
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import type { Message } from "../api/types";
import { useToast } from "../lib/toasts";

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function MailLinks({ message }: { message: Message }) {
  const { t } = useLingui();
  const toast = useToast();
  const [asking, setAsking] = useState<string | null>(null);
  const links = message.links ?? [];
  if (message.direction !== "in" || message.channel !== "email" || links.length === 0) return null;
  return (
    <div className="mlinks" role="group" aria-label={t`Liens du message`}>
      <h3>{t`Liens du message`}</h3>
      {!message.linksOpenable ? (
        <p className="muted">{t`Ouverture désactivée : Gmail n'atteste pas l'expéditeur de ce message. Copiez l'adresse si vous êtes sûr de son origine.`}</p>
      ) : null}
      <ul>
        {links.map((l) => (
          <li key={l.url}>
            <div className="ml-row">
              <b className="ml-host">{l.host}</b>
              <button
                type="button"
                className="btn ghost ml-btn"
                onClick={async () => toast((await copy(l.url)) ? t`Adresse copiée.` : t`La copie n'a pas marché : sélectionnez l'adresse à la main.`)}
              >
                {t`Copier`}
              </button>
              {l.openable ? (
                <button type="button" className="btn ghost ml-btn" aria-expanded={asking === l.url} onClick={() => setAsking(asking === l.url ? null : l.url)}>
                  {t`Ouvrir`}
                </button>
              ) : null}
            </div>
            <small className="ml-url">{l.url}</small>
            {asking === l.url ? (
              <div className="ml-ask" role="alertdialog" aria-label={t`Ouvrir ${l.host} ?`}>
                <p>{t`Vous allez ouvrir ${l.host} dans un nouvel onglet. Vérifiez que ce domaine est bien celui que vous attendez.`}</p>
                <div className="send">
                  <a className="btn pri" href={l.url} target="_blank" rel="noopener noreferrer" onClick={() => setAsking(null)}>
                    {t`Ouvrir ${l.host}`}
                  </a>
                  <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
                    {t`Annuler`}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
