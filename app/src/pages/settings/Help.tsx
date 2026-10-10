// « Comment ça marche » (lot 3) : l'aide intégrée, pour le père de Julien et
// Matthieu. Une journée type, les gestes du calendrier, la vente par
// téléphone, le ménage et son lien, les messages, ce qui se fait tout seul,
// qui appeler. Texte court, vouvoiement ; chaque partie montre l'écran réel
// (captures à 1280 sur des données inventées : app/public/aide/, refaites par
// `node app/e2e/lot3-serveur.mjs`).
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Page } from "../../ui/kit";

const img = (name: string) => `${import.meta.env.BASE_URL}aide/${name}.png`;

function Part({ id, title, shot, alt, children }: { id: string; title: string; shot?: string; alt?: string; children: ReactNode }) {
  return (
    <section className="blk help-part" aria-labelledby={`aide-${id}`}>
      <h2 className="sub" id={`aide-${id}`}>
        {title}
      </h2>
      <div className="help-text">{children}</div>
      {shot ? (
        <figure className="help-shot">
          <img src={img(shot)} alt={alt ?? ""} loading="lazy" width={1280} height={800} />
        </figure>
      ) : null}
    </section>
  );
}

export function HelpPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Comment ça marche`} back width={900} lead={t`L'essentiel en sept points. Rien de ce que vous touchez ici ne peut casser le site : au pire, une modification se refait.`}>
      <nav className="help-toc" aria-label={t`Sommaire`}>
        <a href="#aide-journee">{t`Une journée type`}</a>
        <a href="#aide-calendrier">{t`Le calendrier`}</a>
        <a href="#aide-telephone">{t`Vendre par téléphone`}</a>
        <a href="#aide-menage">{t`Le ménage`}</a>
        <a href="#aide-messages">{t`Les messages`}</a>
        <a href="#aide-auto">{t`Ce qui se fait tout seul`}</a>
        <a href="#aide-appeler">{t`Qui appeler`}</a>
      </nav>

      <Part id="journee" title={t`Une journée type`} shot="aujourdhui" alt={t`L'écran Aujourd'hui : arrivées, départs, ménage, argent à encaisser, messages.`}>
        <p>{t`Ouvrez « Aujourd'hui » le matin. Vous y voyez qui arrive, qui part, les ménages, l'argent à encaisser et les messages qui attendent une réponse.`}</p>
        <p>{t`Touchez une ligne pour ouvrir la réservation : téléphone du client, ce qui est payé, ce qui reste à payer.`}</p>
      </Part>

      <Part id="calendrier" title={t`Le calendrier`} shot="calendrier" alt={t`Le calendrier : une ligne par maison, une barre par séjour.`}>
        <ul className="plain-list">
          <li>{t`Une ligne par maison, une barre par séjour. La couleur dit où en est le paiement.`}</li>
          <li>{t`Touchez une barre : la réservation s'ouvre.`}</li>
          <li>{t`Glissez sur des jours libres d'une maison : vous pouvez vendre ces nuits, changer leur prix ou les bloquer (famille, travaux).`}</li>
          <li>{t`Au téléphone : touchez le premier jour, puis le jour du départ.`}</li>
        </ul>
      </Part>

      <Part id="telephone" title={t`Vendre par téléphone`} shot="vente" alt={t`La vente en trois étapes : dates et maison, voyageurs et prix, client et paiement.`}>
        <ol className="plain-list">
          <li>{t`« Nouvelle vente », ou glissez sur les jours dans le calendrier.`}</li>
          <li>{t`Le prix se calcule tout seul. Notez le nom, le téléphone et, si possible, le mail.`}</li>
          <li>{t`Choisissez « Option » si le client doit encore payer les arrhes : les dates sont gardées en attendant. Un lien de paiement par carte peut lui être envoyé.`}</li>
        </ol>
        <p>{t`Airbnb et Booking sont prévenus tout seuls : les dates n'y sont plus en vente.`}</p>
      </Part>

      <Part id="menage" title={t`Le ménage`} shot="menage" alt={t`L'écran Ménage : un ménage par départ, avec la prochaine arrivée.`}>
        <p>{t`Chaque départ crée un ménage, avec l'heure et la prochaine arrivée. Cochez « fait » quand la maison est prête.`}</p>
        <p>{t`La personne du ménage peut avoir son propre lien, sans mot de passe : envoyez-le-lui par SMS. Elle voit les ménages des deux semaines à venir, sans le nom des voyageurs. Le lien se coupe à tout moment.`}</p>
      </Part>

      <Part id="messages" title={t`Les messages`} shot="messages" alt={t`Les messages : mails des clients, messages du site, d'Airbnb et de Booking.`}>
        <p>{t`Tous les messages arrivent au même endroit : ceux du site, les mails des clients, et ceux d'Airbnb et de Booking. Répondez d'ici : la réponse repart par le bon chemin.`}</p>
        <p>{t`Les modèles de réponse (accès, horaires, solde) se remplissent tout seuls avec la réservation.`}</p>
      </Part>

      <Part id="auto" title={t`Ce qui se fait tout seul`}>
        <ul className="plain-list">
          <li>{t`Toutes les 15 minutes, quand la liaison Beds24 est en place, le serveur envoie les calendriers et les prix à Airbnb et Booking, et reprend leurs réservations et leurs messages.`}</li>
          <li>{t`Le rappel du solde part tout seul au client à l'échéance.`}</li>
          <li>{t`Les options non payées se libèrent toutes seules à la fin du délai.`}</li>
          <li>{t`La base est sauvegardée chaque nuit, photos comprises.`}</li>
          <li>{t`Les avis Airbnb et Booking sont relevés quatre fois par jour : la note moyenne s'affiche sur Aujourd'hui.`}</li>
        </ul>
        <p>
          {t`Si une bande rouge apparaît en haut d'Aujourd'hui, quelque chose ne passe plus : lisez-la, elle dit quoi faire.`}{" "}
          <Link to="/reglages/journaux">{t`Les journaux`}</Link>
        </p>
      </Part>

      <Part id="appeler" title={t`Qui appeler`}>
        <ul className="plain-list">
          <li>{t`Julien : l'écran, les prix, les accès, Airbnb, Booking et Beds24.`}</li>
          <li>{t`Matthieu : le site ne s'ouvre plus du tout (il s'occupe de l'hébergement chez Infomaniak).`}</li>
          <li>{t`Un client qui hésite ou un paiement qui n'arrive pas : appelez le client, son numéro est dans la réservation.`}</li>
        </ul>
      </Part>
    </Page>
  );
}
