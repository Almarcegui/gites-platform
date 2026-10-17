import { t } from "@lingui/core/macro";

// Modèles de réponse (plan v4, fonction 2) : le texte vient de la base
// (Réglages › Modèles de réponse, migration 0023) ; ici, seulement le
// remplissage des variables à partir de la réservation.
//
// Variables : {prenom} {bien} {arrivee} {solde} {heure_arrivee}
// {heure_depart} {signature}. Une variable inconnue, ou que le contexte ne sait pas
// remplir (message sans réservation liée : ni bien ni date d'arrivée), reste
// visible telle quelle : mieux vaut « {bien} » à corriger qu'un trou dans le message.

export interface TemplateContext {
  firstName: string;
  unitName: string;
  arrival: string;
  checkinTime: string;
  checkoutTime: string;
  balance: string | null;
  signature: string;
}

/** Les variables et leur libellé, dans la langue de l'écran (le nom entre
 *  accolades, lui, ne change pas : il est écrit dans les modèles). */
export function templateVariables(): { key: string; label: string }[] {
  return [
    { key: "prenom", label: t`prénom du client` },
    { key: "bien", label: t`nom du bien` },
    { key: "arrivee", label: t`jour d'arrivée` },
    { key: "solde", label: t`solde restant` },
    { key: "heure_arrivee", label: t`heure d'arrivée` },
    { key: "heure_depart", label: t`heure de départ` },
    { key: "signature", label: t`signature` },
  ];
}

export function fillTemplate(body: string, c: TemplateContext): string {
  const values: Record<string, string> = {
    prenom: c.firstName.trim(),
    ...(c.unitName ? { bien: c.unitName } : {}),
    ...(c.arrival ? { arrivee: c.arrival } : {}),
    solde: c.balance ?? "0 €",
    heure_arrivee: c.checkinTime,
    heure_depart: c.checkoutTime,
    signature: c.signature,
  };
  // « Bonjour {prenom}, » sans prénom connu : « Bonjour, », pas « Bonjour , ».
  let out = values.prenom ? body : body.replace(/ \{prenom\}/g, "");
  out = out.replace(/\{([a-z_]+)\}/g, (all, k: string) => (k in values ? (values[k] ?? "") : all));
  return out;
}

/** Variables restées entre accolades dans un texte rempli : à compléter avant l'envoi. */
export function unfilledVariables(text: string): string[] {
  return [...new Set(text.match(/\{[a-z_]+\}/g) ?? [])];
}
