// Modèles de réponse (plan v4, fonction 2) : le texte vient de la base
// (Réglages › Modèles de réponse, migration 0023) ; ici, seulement le
// remplissage des variables à partir de la réservation.
//
// Variables : {prenom} {bien} {arrivee} {solde} {heure_arrivee}
// {heure_depart} {signature}. Une variable inconnue reste visible telle quelle :
// mieux vaut « {code} » à corriger qu'un trou dans le message.

export interface TemplateContext {
  firstName: string;
  unitName: string;
  arrival: string;
  checkinTime: string;
  checkoutTime: string;
  balance: string | null;
  signature: string;
}

export const TEMPLATE_VARIABLES: { key: string; label: string }[] = [
  { key: "prenom", label: "prénom du client" },
  { key: "bien", label: "nom du bien" },
  { key: "arrivee", label: "jour d'arrivée" },
  { key: "solde", label: "solde restant" },
  { key: "heure_arrivee", label: "heure d'arrivée" },
  { key: "heure_depart", label: "heure de départ" },
  { key: "signature", label: "signature" },
];

export function fillTemplate(body: string, c: TemplateContext): string {
  const values: Record<string, string> = {
    prenom: c.firstName.trim(),
    bien: c.unitName,
    arrivee: c.arrival,
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
