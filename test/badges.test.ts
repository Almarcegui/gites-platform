// Badges temporels des réservations (issue #53).
//
// La logique tient en trois comparaisons de chaînes, mais elle décide de ce
// qu'un gestionnaire lit le matin sur trois écrans à la fois (liste, fiche,
// tableau de bord). Elle est donc isolée dans `public/admin/badges.js` — sans
// DOM ni import — précisément pour être testée ici (même parti pris que
// `suggestions.js`).
import { describe, expect, it } from "vitest";

// @ts-expect-error — module ESM du front, sans typage TypeScript
import { stayBadge, stayPhase } from "../public/admin/badges.js";

const TODAY = "2026-08-28";

/** Une réservation au format renvoyé par `GET /api/admin/bookings`. */
function resa(over: Record<string, unknown> = {}) {
  return { status: "confirmed", checkin: "2026-09-10", checkout: "2026-09-17", ...over };
}

describe("stayPhase", () => {
  it("reconnaît une arrivée du jour", () => {
    expect(stayPhase(resa({ checkin: TODAY, checkout: "2026-09-04" }), TODAY)).toBe("arrive-today");
  });

  it("reconnaît une arrivée du lendemain, y compris en fin de mois", () => {
    expect(stayPhase(resa({ checkin: "2026-08-29", checkout: "2026-09-05" }), TODAY)).toBe("arrive-tomorrow");
    // 31 août → 1er septembre : le passage de mois est le cas qui casse quand
    // on additionne des jours à la main.
    expect(stayPhase(resa({ checkin: "2026-09-01", checkout: "2026-09-08" }), "2026-08-31")).toBe("arrive-tomorrow");
    // 28 février 2027 → 1er mars (2027 n'est pas bissextile).
    expect(stayPhase(resa({ checkin: "2027-03-01", checkout: "2027-03-08" }), "2027-02-28")).toBe("arrive-tomorrow");
  });

  it("reconnaît un départ du jour", () => {
    expect(stayPhase(resa({ checkin: "2026-08-21", checkout: TODAY }), TODAY)).toBe("leaves-today");
  });

  it("ne dit rien sur un séjour lointain, ni sur un séjour déjà terminé", () => {
    expect(stayPhase(resa(), TODAY)).toBeNull();
    expect(stayPhase(resa({ checkin: "2026-08-01", checkout: "2026-08-08" }), TODAY)).toBeNull();
  });

  it("une réservation en cours n'est ni une arrivée ni un départ", () => {
    expect(stayPhase(resa({ checkin: "2026-08-25", checkout: "2026-09-02" }), TODAY)).toBeNull();
  });

  it("une annulation ne porte aucun badge temporel — sinon le planning du jour annonce des fantômes", () => {
    expect(stayPhase(resa({ status: "cancelled", checkin: TODAY, checkout: "2026-09-04" }), TODAY)).toBeNull();
  });

  it("une option non payée en garde un : c'est exactement ce qu'il faut voir la veille", () => {
    expect(stayPhase(resa({ status: "pending", checkin: "2026-08-29", checkout: "2026-09-05" }), TODAY)).toBe(
      "arrive-tomorrow",
    );
  });

  it("ne casse pas sur une ligne incomplète (mouvement du tableau de bord sans dates)", () => {
    expect(stayPhase({ status: "confirmed" }, TODAY)).toBeNull();
    expect(stayPhase(null, TODAY)).toBeNull();
  });

  it("ne lève jamais sur un jour de référence absent ou aberrant — un badge ne doit pas vider l'écran", () => {
    expect(stayPhase(resa({ checkin: TODAY }))).toBeNull();
    expect(stayPhase(resa({ checkin: TODAY }), "")).toBeNull();
    expect(stayPhase(resa({ checkin: TODAY }), "pas-une-date")).toBeNull();
    expect(stayBadge(resa({ checkin: TODAY }), undefined)).toBe("");
  });

  // Le tableau de bord liste une ligne PAR MOUVEMENT : la même réservation y
  // apparaît deux fois, une fois « → arrivée » et une fois « ← départ ». Sans
  // ce paramètre, la ligne de départ du 02/09 d'un séjour commencé aujourd'hui
  // affichait « arrive aujourd'hui » en face d'une flèche de départ.
  describe("lecture restreinte à un mouvement", () => {
    const seJour = resa({ checkin: TODAY, checkout: "2026-09-02" });

    it("la ligne d'arrivée ne parle que de l'arrivée", () => {
      expect(stayPhase(seJour, TODAY, "arrival")).toBe("arrive-today");
    });

    it("la ligne de départ du même séjour ne dit rien tant que le départ n'est pas pour aujourd'hui", () => {
      expect(stayPhase(seJour, TODAY, "departure")).toBeNull();
    });

    it("mais elle parle quand le départ est bien du jour", () => {
      expect(stayPhase(resa({ checkin: "2026-08-21", checkout: TODAY }), TODAY, "departure")).toBe("leaves-today");
    });

    it("et une arrivée du lendemain ne s'affiche pas sur une ligne de départ", () => {
      expect(stayPhase(resa({ checkin: "2026-08-29", checkout: "2026-09-05" }), TODAY, "departure")).toBeNull();
    });
  });
});

describe("stayBadge", () => {
  it("rend une pastille lisible, avec la classe de couleur attendue", () => {
    expect(stayBadge(resa({ checkin: TODAY, checkout: "2026-09-04" }), TODAY)).toBe(
      '<span class="tag t-now">Arrive aujourd’hui</span>',
    );
    expect(stayBadge(resa({ checkin: "2026-08-29", checkout: "2026-09-05" }), TODAY)).toBe(
      '<span class="tag t-soon">Arrive demain</span>',
    );
    expect(stayBadge(resa({ checkin: "2026-08-21", checkout: TODAY }), TODAY)).toBe(
      '<span class="tag t-now">Part aujourd’hui</span>',
    );
  });

  it("rend une chaîne vide quand il n'y a rien à signaler — le badge financier reste seul", () => {
    expect(stayBadge(resa(), TODAY)).toBe("");
  });
});
