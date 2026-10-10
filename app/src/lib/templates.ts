// Modèles de réponse (plan v4, fonction 2) — PILOTE : en constantes, en
// attendant la table `message_templates` et son écran dans Réglages.
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export type TemplateId = "acces" | "horaires" | "solde" | "apres";

export interface TemplateContext {
  firstName: string;
  unitName: string;
  arrival: string;
  checkinTime: string;
  checkoutTime: string;
  balance: string | null;
  signature: string;
}

export const templateLabels = (): { id: TemplateId; label: string }[] => [
  { id: "acces", label: i18n._(msg`Accès et clés`) },
  { id: "horaires", label: i18n._(msg`Horaires`) },
  { id: "solde", label: i18n._(msg`Rappel du solde`) },
  { id: "apres", label: i18n._(msg`Après le séjour`) },
];

export function fillTemplate(id: TemplateId, c: TemplateContext): string {
  const hello = c.firstName ? `Bonjour ${c.firstName},` : "Bonjour,";
  switch (id) {
    case "acces":
      return `${hello}\n\n${c.unitName} vous attend ${c.arrival}, à partir de ${c.checkinTime}.\nLes clés sont dans la boîte à code, à côté de la porte d'entrée. Le code vous parvient par SMS le matin de votre arrivée.\nVous pouvez vous garer devant la maison.\n\nBonne route,\n${c.signature}`;
    case "horaires":
      return `${hello}\n\nL'arrivée se fait à partir de ${c.checkinTime} et le départ avant ${c.checkoutTime}.\nSi vous avez besoin d'un peu plus de souplesse, dites-le-nous : nous regardons ce qui est possible selon les voyageurs suivants.\n\nÀ bientôt,\n${c.signature}`;
    case "solde":
      return c.balance
        ? `${hello}\n\nPetit rappel : le solde de votre séjour à ${c.unitName}, soit ${c.balance}, reste à régler avant votre arrivée. Le lien de paiement figure dans votre confirmation de réservation.\n\nMerci, et à bientôt,\n${c.signature}`
        : `${hello}\n\nVotre séjour à ${c.unitName} est entièrement payé : vous n'avez rien à régler sur place.\n\nÀ bientôt,\n${c.signature}`;
    case "apres":
      return `${hello}\n\nMerci d'avoir séjourné à ${c.unitName}. Nous espérons que tout vous a plu.\nUn mot sur votre séjour nous aide beaucoup, et vous êtes toujours les bienvenus.\n\nAu plaisir de vous revoir,\n${c.signature}`;
  }
}
