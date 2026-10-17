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

const cibles = [...document.querySelectorAll("[data-deposit-unit]")];
const fraisCibles = [...document.querySelectorAll("[data-frais-unit]")];

if (cibles.length || fraisCibles.length) {
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
        const cents = u.isComposite
          ? units.filter((x) => !x.isComposite).reduce((t, x) => t + x.cleaningFeeCents, 0)
          : u.cleaningFeeCents;
        if (typeof cents === "number" && cents > 0) {
          const eur = cents / 100;
          cible.textContent = `${Number.isInteger(eur) ? eur : eur.toFixed(2).replace(".", ",")} €`;
        }
      } catch {
        // Repli du HTML conservé.
      }
    })();
  }
}
