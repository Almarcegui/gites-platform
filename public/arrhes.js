// Pourcentage d'arrhes annoncé sur les pages publiques (issue #75).
//
// Même principe que les prix : aucun pourcentage n'est écrit en dur dans le
// HTML. Il se règle par hébergement dans le back-office (`units.deposit_pct`,
// migration 0015) et une valeur figée dans une page finit toujours par mentir —
// c'est exactement ce qui s'était produit, les pages annonçant 30 % alors que
// le réglage en vigueur est 50 %.
//
// La source est la fiche domaine (`/api/public/properties/<slug>`), qui expose
// le pourcentage EFFECTIF de chaque hébergement : le repli sur le réglage du
// domaine est déjà résolu côté serveur.
//
// Chaque cible porte deux attributs :
//   data-deposit-property  slug du domaine
//   data-deposit-unit      id de l'hébergement, ou « all » pour une page qui en
//                          couvre plusieurs (l'accueil) — le pourcentage n'est
//                          alors injecté que s'il est identique partout.
//
// Le HTML garde un repli lisible (« selon l'hébergement ») qui reste en place
// si l'appel échoue ou si les hébergements divergent. La phrase se lit
// correctement dans les deux cas : « arrhes de 50 % » ou « arrhes selon
// l'hébergement ».

// Les fonctions pures ci-dessous sont exportées pour les tests (Node, sans
// `document`) ; le module garde son effet de bord sur les pages.
const doc = typeof document === "undefined" ? null : document;
const cibles = doc ? [...doc.querySelectorAll("[data-deposit-unit]")] : [];
const fraisCibles = doc ? [...doc.querySelectorAll("[data-frais-unit]")] : [];
const totalCibles = doc ? [...doc.querySelectorAll("[data-total-exemple-unit]")] : [];

// Hébergements dont les frais s'additionnent pour `u` : un bien composite en
// mode « somme » additionne les maisons qu'il bloque (unit_links), pas toutes
// celles du domaine.
export function partiesFrais(units, u) {
  return u.isComposite && u.compositePricing === "sum"
    ? (u.componentIds || []).map((id) => units.find((x) => x.id === id)).filter(Boolean)
    : [u];
}

// Frais généraux (centimes) pour un séjour de `nuits` nuits — même formule que
// `generalFeeCents` du moteur de devis : forfait + supplément par nuit au-delà
// des nuits incluses.
export function fraisSejourCents(parts, nuits) {
  return parts.reduce((t, x) => {
    const inclus = x.feeIncludedNights ?? 2;
    return t + x.cleaningFeeCents + Math.max(0, nuits - inclus) * (x.chargesExtraNightCents || 0);
  }, 0);
}

// Montant à l'affichage : euros entiers tels quels, centimes seulement quand il
// y en a (177,50 €), espace insécable avant « € » (jamais de « € » seul en
// début de ligne). Toutes les sommes de la page s'additionnent ainsi exactement.
export function fmtEuros(cents) {
  const e = cents / 100;
  return `${Number.isInteger(e) ? e : e.toFixed(2).replace(".", ",")}\u00a0€`;
}

// Calendrier et date du jour partagés par tous les scripts de la page (arrhes.js,
// site.js, prix.js) : une seule requête par mois, une seule pour « aujourd'hui »
// (date belge servie par l'API, pas l'horloge du navigateur).
const caches = new Map();
function unefois(cle, charge) {
  if (!caches.has(cle)) {
    caches.set(cle, charge().catch((e) => { caches.delete(cle); throw e; }));
  }
  return caches.get(cle);
}
const json = (res) => {
  if (!res.ok) throw new Error(`${res.url} ${res.status}`);
  return res.json();
};
export const aujourdhui = () => unefois("today", () => fetch("/api/public/today").then(json).then((t) => t.today));
export const calendrierMois = (slug, mois) =>
  unefois(`${slug}/${mois}`, () => fetch(`/api/public/calendar?property=${encodeURIComponent(slug)}&month=${mois}`).then(json));
export const moisSuivant = (m) => {
  const [a, n] = m.split("-").map(Number);
  return new Date(Date.UTC(a, n, 1)).toISOString().slice(0, 7);
};

const ajouterJours = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Séjour de 2 nuits le moins cher RÉELLEMENT réservable pour un hébergement :
// on ne prend pas « 2 × la nuit la moins chère », on parcourt les vraies paires
// de nuits, avec les règles du moteur de devis lues dans le calendrier public :
//   · arrivée réservable (`available` : après le délai minimum, nuit libre) ;
//   · seconde nuit libre et tarifée aussi (elle peut tomber dans le mois
//     suivant : `mois` contient donc un mois de plus que la fenêtre d'arrivée) ;
//   · minimum de nuits de la nuit d'arrivée ≤ 2 ;
//   · jours d'arrivée imposés : nul, ou contenant le jour de la semaine d'arrivée.
// `jusquau` = dernière date d'arrivée envisagée (incluse). Rend
// { arrivee, cents } (somme des deux nuits, hors frais) ou null s'il n'y a aucune
// paire — la mention est alors masquée plutôt que d'afficher un prix inatteignable.
export function meilleurSejour2Nuits(mois, unitId, jusquau) {
  const jours = new Map();
  for (const m of mois) {
    const u = m.units.find((x) => x.unitId === unitId);
    for (const j of u ? u.days : []) jours.set(j.date, j);
  }
  let meilleur = null;
  for (const [date, a] of jours) {
    if (date > jusquau || !a.available || a.priceCents == null) continue;
    if ((a.minNights ?? 1) > 2) continue;
    if (a.checkinDays != null && !a.checkinDays.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) continue;
    const b = jours.get(ajouterJours(date, 1));
    if (!b || !b.available || b.priceCents == null) continue;
    const cents = a.priceCents + b.priceCents;
    if (meilleur == null || cents < meilleur.cents || (cents === meilleur.cents && date < meilleur.arrivee)) {
      meilleur = { arrivee: date, cents };
    }
  }
  return meilleur;
}

// Total d'exemple « 2 nuits dès X € tout compris » (art. VI.4 CDE : le prix
// annoncé inclut les services à payer obligatoirement) : la meilleure paire de
// nuits + les frais généraux du séjour, au centime. Pas de taxe de séjour : le
// moteur n'en facture aucune.
export function totalExempleCents(sejour, parts) {
  return sejour == null ? null : sejour.cents + fraisSejourCents(parts, 2);
}

if (cibles.length || fraisCibles.length || totalCibles.length) {
  const fiches = new Map(); // slug → promesse de fiche domaine, une seule requête par domaine

  const fiche = (slug) => {
    if (!fiches.has(slug)) {
      fiches.set(
        slug,
        fetch(`/api/public/properties/${encodeURIComponent(slug)}`).then((res) => {
          if (!res.ok) throw new Error(`fiche ${res.status}`);
          return res.json();
        }),
      );
    }
    return fiches.get(slug);
  };

  for (const cible of cibles) {
    (async () => {
      try {
        const { units } = await fiche(cible.dataset.depositProperty);
        const demande = cible.dataset.depositUnit;
        let pct = null;
        if (demande === "all") {
          const distincts = [...new Set(units.map((u) => u.depositPct))];
          if (distincts.length === 1) pct = distincts[0];
        } else {
          pct = units.find((u) => u.id === Number(demande))?.depositPct ?? null;
        }
        if (typeof pct === "number") cible.textContent = `de ${pct} %`;
      } catch {
        // Repli du HTML conservé tel quel — mieux vaut « selon l'hébergement »
        // qu'un pourcentage inventé.
      }
    })();
  }

  // Frais généraux (ménage et charges), même principe : le montant écrit en dur
  // dans les pages (120 / 90 / 210 €) ne suivait plus le moteur (170 / 140 /
  // 310 €) — le visiteur voyait un chiffre sur la page et en payait un autre.
  // L'unité composite (« les deux maisons ») a un ménage nul en base : le
  // moteur le calcule en additionnant ses maisons, la page fait de même.
  //   data-frais-property  slug du domaine
  //   data-frais-unit      id de l'hébergement
  // Le HTML garde un repli sans montant (« voir le devis ») si l'appel échoue.
  for (const cible of fraisCibles) {
    (async () => {
      try {
        const { units } = await fiche(cible.dataset.fraisProperty);
        const u = units.find((x) => x.id === Number(cible.dataset.fraisUnit));
        if (!u) return;
        // Forfait + supplément par nuit au-delà des nuits incluses (migration
        // 0038), calculés comme le moteur de devis (cf. partiesFrais). Le texte
        // n'a pas de parenthèse : le HTML ajoute déjà « (ménage et charges) »
        // derrière.
        const parts = partiesFrais(units, u);
        const cents = parts.reduce((t, x) => t + x.cleaningFeeCents, 0);
        const avecSupplement = parts.filter((x) => (x.chargesExtraNightCents || 0) > 0);
        const extra = avecSupplement.reduce((t, x) => t + x.chargesExtraNightCents, 0);
        const inclus = parts[0]?.feeIncludedNights ?? 2;
        const memeRegle = parts.every((x) => (x.feeIncludedNights ?? 2) === inclus);
        const fmt = fmtEuros;
        if (typeof cents === "number" && cents > 0) {
          cible.textContent = avecSupplement.length === 0
            ? fmt(cents)
            : memeRegle
              ? `${fmt(cents)} pour ${inclus} nuit${inclus > 1 ? "s" : ""}, +${fmt(extra)}/nuit ensuite`
              : `${fmt(cents)} + charges par nuit au-delà, selon la maison`;
        }
      } catch {
        // Repli du HTML conservé.
      }
    })();
  }

  // Total d'exemple « 2 nuits dès X € tout compris » : mêmes données que
  // l'affichage « à partir de » (calendrier tarifaire) et que les frais
  // généraux (fiche domaine), rien n'est écrit en dur.
  //   data-total-exemple-property  slug du domaine
  //   data-total-exemple-unit      id de l'hébergement
  // La cible porte `hidden` (cartes) ou un repli lisible (tableau) : si un
  // appel échoue ou s'il n'y a aucune paire de nuits réservable, la page
  // n'affiche aucun total plutôt qu'un total inventé. « (prochains mois) » dit
  // l'horizon : le minimum est celui de la fenêtre, pas un minimum absolu.
  for (const cible of totalCibles) {
    (async () => {
      try {
        const slug = cible.dataset.totalExempleProperty;
        const id = Number(cible.dataset.totalExempleUnit);
        const today = await aujourdhui();
        const m1 = today.slice(0, 7);
        const m2 = moisSuivant(m1);
        // Fenêtre d'arrivée : le mois en cours et le suivant ; un troisième mois
        // sert à la seconde nuit d'une arrivée le dernier jour de la fenêtre.
        const [{ units }, ...mois] = await Promise.all([
          fiche(slug),
          ...[m1, m2, moisSuivant(m2)].map((m) => calendrierMois(slug, m)),
        ]);
        const u = units.find((x) => x.id === id);
        const dernier = `${m2}-31`; // comparaison de chaînes : tout jour de m2 est <= m2-31
        const cents = u && totalExempleCents(meilleurSejour2Nuits(mois, id, dernier), partiesFrais(units, u));
        if (cents == null) return; // aucune paire réservable : la mention reste masquée
        cible.textContent = `2 nuits dès ${fmtEuros(cents)} tout compris (prochains mois)`;
        cible.hidden = false;
      } catch {
        // Repli du HTML conservé.
      }
    })();
  }
}
