// Shortcode WordPress : le code à coller pour intégrer le moteur de
// réservation dans un site WordPress (iframe du tunnel /book/). Les options
// utiles sont listées en clair, avec le code complet prêt à copier. La doc
// complète (fonction PHP à coller dans functions.php) vit dans
// docs/integration-wordpress.md.
import { useLingui } from "@lingui/react/macro";
import { IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { useToast } from "../../lib/toasts";
import { Page, Section, useWorkingProperty } from "../../ui/kit";

function CodeBlock({ text, label, onCopy }: { text: string; label: string; onCopy: (text: string, label: string) => void }) {
  return (
    <div className="list-row two static">
      <span>
        <b>{label}</b>
        <small className="mono-line">{text}</small>
      </span>
      <button type="button" className="btn" onClick={() => onCopy(text, label)}>
        <IconCopy size={20} />
      </button>
    </div>
  );
}

export function ShortcodePage() {
  const { t } = useLingui();
  const { property, picker } = useWorkingProperty();
  const toast = useToast();
  const [lang, setLang] = useState<"fr" | "nl">("fr");

  const slug = property?.slug ?? "";
  const base = `${window.location.origin}/book/`;
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t`${label} copié.`);
    } catch {
      toast(t`Le code n'a pas pu être copié : sélectionnez-le et copiez-le à la main.`, true);
    }
  };

  const url = `${base}?property=${slug}&lang=${lang}`;
  const shortcode = `[gites_reservation property="${slug}" lang="${lang}"]`;
  const options: [string, string][] = [
    ["property", t`Le domaine qui reçoit la réservation (ici : ${property?.name ?? "—"}).`],
    ["lang", t`La langue du tunnel : fr ou nl. Sans elle, la langue de l'appareil du visiteur.`],
    ["height", t`La hauteur de l'iframe en pixels (1400 par défaut). À agrandir si le tunnel déborde.`],
    ["checkin / checkout", t`Dates d'arrivée et de départ proposées d'avance (AAAA-MM-JJ).`],
    ["adults / children", t`Nombre d'adultes et d'enfants proposés d'avance.`],
    ["unit", t`L'hébergement présélectionné quand il y en a plusieurs.`],
  ];

  return (
    <Page title={t`Shortcode WordPress`} back tools={picker} lead={t`Le moteur de réservation de votre site, à intégrer dans une page WordPress. Copiez le code ci-dessous ; la marche à suivre complète est dans docs/integration-wordpress.md.`}>
      <Section title={t`Le shortcode`} hint={t`À utiliser dans une page ou un article WordPress, une fois la fonction PHP collée dans le thème (voir la doc).`}>
        <div className="panel">
          <CodeBlock text={shortcode} label={t`Shortcode`} onCopy={copy} />
        </div>
      </Section>
      <Section title={t`L'adresse du tunnel`} hint={t`Pour un bloc HTML WordPress sans PHP, ou tout autre site : cette adresse s'incruste dans une iframe. Elle accepte les mêmes options.`}>
        <div className="panel">
          <CodeBlock text={url} label={t`Adresse`} onCopy={copy} />
        </div>
        <div className="chips" role="group" aria-label={t`Langue du tunnel`}>
          {(["fr", "nl"] as const).map((l) => (
            <button key={l} type="button" className="chip" aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l === "fr" ? t`Français` : t`Néerlandais`}
            </button>
          ))}
        </div>
      </Section>
      <Section title={t`Les options`} hint={t`Elles se collent dans le shortcode, séparées par des espaces : [gites_reservation option="valeur"].`}>
        <div className="panel">
          {options.map(([k, v]) => (
            <div key={k} className="list-row two static">
              <span>
                <b className="mono-line">{k}</b>
              </span>
              <small>{v}</small>
            </div>
          ))}
        </div>
      </Section>
    </Page>
  );
}
