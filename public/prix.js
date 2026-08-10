// Prix « à partir de » des pages de gîtes (issue #33).
//
// Même source que la page d'accueil : le calendrier tarifaire réel, servi par
// /api/public/calendar. Aucun montant n'est écrit en dur dans le HTML — les
// tarifs se règlent dans le back-office, et un prix figé dans une page finit
// toujours par mentir. C'est aussi pourquoi le bloc JSON-LD de ces pages
// n'annonce pas de prix : publier une donnée structurée périmée coûte plus cher
// qu'omettre le champ.
//
// Volontairement séparé de `site.js`, qui ne sert que la page d'accueil et
// déclenche des appels dont ces pages n'ont que faire (calendrier, contact).

const cibles = [...document.querySelectorAll("[data-prix-unite]")];

if (cibles.length) {
  const eur = (cents) => `${Math.round(cents / 100)} €`;

  const moisSuivant = (m) => {
    const [a, n] = m.split("-").map(Number);
    return new Date(Date.UTC(a, n, 1)).toISOString().slice(0, 7);
  };

  async function charger(domaine, mois) {
    const url = `/api/public/calendar?property=${encodeURIComponent(domaine)}&month=${mois}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`calendrier ${res.status}`);
    return res.json();
  }

  for (const cible of cibles) {
    const domaine = cible.dataset.prixDomaine;
    const unite = Number(cible.dataset.prixUnite);

    (async () => {
      try {
        // Deux mois de fenêtre, comme la page d'accueil : assez pour tomber sur
        // un tarif de semaine hors saison, qui est le « à partir de » honnête.
        const m1 = new Date().toISOString().slice(0, 7);
        const donnees = await Promise.all([charger(domaine, m1), charger(domaine, moisSuivant(m1))]);

        let min = null;
        for (const mois of donnees) {
          for (const u of mois.units) {
            if (u.unitId !== unite) continue;
            for (const j of u.days) {
              if (j.past || j.priceCents == null) continue;
              if (min == null || j.priceCents < min) min = j.priceCents;
            }
          }
        }
        cible.textContent = min == null ? "sur demande" : eur(min);
      } catch {
        // Le tunnel de réservation reste accessible : mieux vaut « sur demande »
        // qu'un tiret qui laisse croire à une page à moitié cassée.
        cible.textContent = "sur demande";
      }
    })();
  }
}
