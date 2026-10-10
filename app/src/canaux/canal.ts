// Messages des canaux (Airbnb, Booking.com, Vrbo, Expedia relevés par Beds24) dans
// l'écran Messages : le badge de provenance, la phrase sous la réponse, et le
// texte de confirmation après l'envoi. Un message de canal se répond sur le
// canal (par Beds24), jamais par mail : l'adresse du voyageur y est un relais.
import { t } from "@lingui/core/macro";
import type { Message } from "../api/types";
import "./canal.css";

export interface SourceBadge {
  cls: string;
  text: string;
}

/** Famille du canal, pour la couleur du badge. */
function family(canal: string): "airbnb" | "booking" | "autre" {
  const k = canal.toLowerCase();
  if (k.includes("airbnb")) return "airbnb";
  if (k.includes("booking")) return "booking";
  return "autre";
}

/** Badge de provenance d'un message : votre site, mail, ou le canal OTA. */
export function sourceLabel(m: Pick<Message, "channel" | "canal">): SourceBadge {
  if (m.channel === "beds24") {
    const canal = m.canal || "Canal";
    return { cls: `canal canal-${family(canal)}`, text: canal };
  }
  return m.channel === "form" ? { cls: "st", text: t`Votre site` } : { cls: "", text: t`Mail` };
}

export function isChannelMessage(m: Pick<Message, "channel">): boolean {
  return m.channel === "beds24";
}

/** La phrase sous le champ de réponse. */
export function replyHint(m: Pick<Message, "channel" | "canal" | "fromEmail" | "bookingId">): string {
  if (m.channel === "beds24") return t`La réponse part sur ${m.canal || t`le canal`}, dans la conversation du voyageur (par Beds24).`;
  const to = m.fromEmail;
  return m.bookingId ? t`La réponse part par mail à ${to} quand l'envoi des mails est actif, et s'affiche sur la page du client.` : t`La réponse part par mail à ${to} quand l'envoi des mails est actif.`;
}

/** Confirmation après l'envoi d'une réponse partie par le canal ; null sinon. */
export function channelDeliveryText(delivery: string | undefined, canal: string | null | undefined): string | null {
  return delivery === "beds24" ? t`C'est fait. Réponse envoyée sur ${canal || t`le canal`}.` : null;
}

/** Nom affiché d'un correspondant : jamais l'adresse pseudo « beds24:<id> ». */
export function displayName(m: Pick<Message, "fromName" | "fromEmail" | "channel" | "canal">): string {
  if (m.fromName) return m.fromName;
  if (m.channel === "beds24" && m.fromEmail.startsWith("beds24:")) return m.canal ? t`Voyageur ${m.canal}` : t`Voyageur du canal`;
  return m.fromEmail;
}
