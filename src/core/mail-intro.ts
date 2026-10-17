// Intro personnalisable des mails automatiques (confirmation, annulation,
// relance d'abandon) : le texte vient des réglages du domaine (Réglages ›
// Modèles de réponse), vide = texte d'origine du mail.
//
// Variables : celles des modèles de réponse ({prenom} {bien} {arrivee} {solde}
// {heure_arrivee} {heure_depart} {signature}), plus {reference} et {lien}.
// Une variable inconnue reste visible telle quelle : mieux vaut « {code} » à
// corriger qu'un trou dans le message.

export interface IntroVariables {
  prenom?: string;
  bien?: string;
  arrivee?: string;
  solde?: string;
  heure_arrivee?: string;
  heure_depart?: string;
  signature?: string;
  reference?: string;
  lien?: string;
}

/** L'intro d'un mail : null si le réglage est vide (texte d'origine), sinon
 *  chaque ligne remplie avec les variables connues. */
export function mailIntroLines(
  raw: string,
  vars: IntroVariables,
): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const values: Record<string, string> = {
    prenom: vars.prenom ?? "",
    bien: vars.bien ?? "",
    arrivee: vars.arrivee ?? "",
    solde: vars.solde ?? "",
    heure_arrivee: vars.heure_arrivee ?? "",
    heure_depart: vars.heure_depart ?? "",
    signature: vars.signature ?? "",
    reference: vars.reference ?? "",
    lien: vars.lien ?? "",
  };
  const fill = (s: string) =>
    s.replace(/\{([a-z_]+)\}/g, (all, k: string) =>
      k in values ? values[k]! : all,
    );
  // « Bonjour {prenom}, » sans prénom connu : « Bonjour, », pas « Bonjour , ».
  const out = values.prenom
    ? trimmed
    : trimmed.replace(/ \{prenom\}/g, "");
  return out.split(/\r?\n/).map((l) => fill(l));
}
