// Tests du moteur de disponibilité lié (implémentation pure TypeScript).
// La même matrice de cas est rejouée contre la vraie base D1 (SQL atomique)
// dans booking-db.test.ts.
import { describe, expect, it } from "vitest";
import {
  isActiveBooking,
  isUnitFree,
  blockingUnitIds,
  busySpans,
  mergeSpans,
  type BookingSpan,
  type UnitLink,
} from "../src/core/availability";
import { addDays, diffDays, eachNight, isIsoDate, rangesOverlap } from "../src/core/dates";

// Fixtures Pré Moré : 1 = Maison du Scieur, 2 = La Scierie, 3 = Domaine entier.
const LINKS: UnitLink[] = [
  { unitId: 1, blocksUnitId: 3 },
  { unitId: 2, blocksUnitId: 3 },
  { unitId: 3, blocksUnitId: 1 },
  { unitId: 3, blocksUnitId: 2 },
];
const NOW = "2026-06-01 12:00:00";

function confirmed(unitId: number, checkin: string, checkout: string): BookingSpan {
  return { unitId, checkin, checkout, status: "confirmed" };
}

describe("helpers de dates", () => {
  it("valide strictement le format ISO", () => {
    expect(isIsoDate("2026-07-12")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-7-2")).toBe(false);
    expect(isIsoDate("12/07/2026")).toBe(false);
  });
  it("addDays passe les fins de mois et d'année", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("eachNight exclut le checkout", () => {
    expect(eachNight("2026-08-10", "2026-08-12")).toEqual(["2026-08-10", "2026-08-11"]);
    expect(diffDays("2026-08-10", "2026-08-12")).toBe(2);
  });
  it("chevauchements semi-ouverts : départ et arrivée le même jour sont compatibles", () => {
    expect(rangesOverlap("2026-08-10", "2026-08-12", "2026-08-12", "2026-08-14")).toBe(false);
    expect(rangesOverlap("2026-08-10", "2026-08-12", "2026-08-11", "2026-08-13")).toBe(true);
    expect(rangesOverlap("2026-08-10", "2026-08-12", "2026-08-08", "2026-08-10")).toBe(false);
    expect(rangesOverlap("2026-08-10", "2026-08-12", "2026-08-10", "2026-08-12")).toBe(true);
    expect(rangesOverlap("2026-08-01", "2026-08-31", "2026-08-10", "2026-08-12")).toBe(true);
  });
});

describe("ensembles bloquants (unit_links)", () => {
  it("le Domaine entier est bloqué par les deux maisons, et réciproquement", () => {
    expect([...blockingUnitIds(3, LINKS)].sort()).toEqual([1, 2, 3]);
    expect([...blockingUnitIds(1, LINKS)].sort()).toEqual([1, 3]);
    expect([...blockingUnitIds(2, LINKS)].sort()).toEqual([2, 3]);
  });
});

describe("matrice de liaison A/B/Domaine", () => {
  it("résa Maison du Scieur → Domaine bloqué, Scierie libre", () => {
    const bookings = [confirmed(1, "2026-08-10", "2026-08-12")];
    expect(isUnitFree(1, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(3, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
  });

  it("résa La Scierie → Domaine bloqué, Scieur libre", () => {
    const bookings = [confirmed(2, "2026-08-10", "2026-08-12")];
    expect(isUnitFree(3, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(1, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
  });

  it("résa Domaine entier → les deux maisons bloquées", () => {
    const bookings = [confirmed(3, "2026-08-10", "2026-08-12")];
    expect(isUnitFree(1, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(3, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
  });

  it("les deux maisons peuvent être réservées en même temps par des clients différents", () => {
    const bookings = [confirmed(1, "2026-08-10", "2026-08-12")];
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
  });
});

describe("bornes de chevauchement", () => {
  const bookings = [confirmed(2, "2026-08-10", "2026-08-12")];

  it("rotation le jour même : arrivée le jour du départ = libre", () => {
    expect(isUnitFree(2, "2026-08-12", "2026-08-14", bookings, LINKS, NOW)).toBe(true);
    expect(isUnitFree(2, "2026-08-08", "2026-08-10", bookings, LINKS, NOW)).toBe(true);
  });
  it("tout recouvrement partiel ou total bloque", () => {
    expect(isUnitFree(2, "2026-08-11", "2026-08-13", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-09", "2026-08-11", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-01", "2026-08-31", bookings, LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-11", "2026-08-12", bookings, LINKS, NOW)).toBe(false);
  });
  it("la liaison suit les mêmes bornes : Domaine libre dès le jour du départ", () => {
    expect(isUnitFree(3, "2026-08-12", "2026-08-14", bookings, LINKS, NOW)).toBe(true);
    expect(isUnitFree(3, "2026-08-11", "2026-08-13", bookings, LINKS, NOW)).toBe(false);
  });
});

describe("statuts et holds", () => {
  it("une annulation libère l'unité ET ses liaisons", () => {
    const bookings: BookingSpan[] = [
      { unitId: 3, checkin: "2026-08-10", checkout: "2026-08-12", status: "cancelled" },
    ];
    expect(isUnitFree(1, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
    expect(isUnitFree(3, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
  });

  it("un hold pending actif bloque ; un hold expiré ne bloque plus", () => {
    const active: BookingSpan = {
      unitId: 2, checkin: "2026-08-10", checkout: "2026-08-12",
      status: "pending", holdExpiresAt: "2026-06-01 12:30:00",
    };
    const expired: BookingSpan = { ...active, holdExpiresAt: "2026-06-01 11:30:00" };
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", [active], LINKS, NOW)).toBe(false);
    expect(isUnitFree(3, "2026-08-10", "2026-08-12", [active], LINKS, NOW)).toBe(false);
    expect(isUnitFree(2, "2026-08-10", "2026-08-12", [expired], LINKS, NOW)).toBe(true);
    expect(isUnitFree(3, "2026-08-10", "2026-08-12", [expired], LINKS, NOW)).toBe(true);
  });

  it("isActiveBooking : pending sans hold_expires_at ne bloque pas", () => {
    expect(isActiveBooking({ status: "pending", holdExpiresAt: null }, NOW)).toBe(false);
    expect(isActiveBooking({ status: "confirmed" }, NOW)).toBe(true);
    expect(isActiveBooking({ status: "cancelled" }, NOW)).toBe(false);
  });
});

describe("unités d'un autre domaine", () => {
  it("les résas du Pré Moré n'affectent pas une unité non liée (Moulin)", () => {
    const bookings = [confirmed(3, "2026-08-01", "2026-08-31")];
    expect(isUnitFree(4, "2026-08-10", "2026-08-12", bookings, LINKS, NOW)).toBe(true);
  });
});

describe("périodes occupées (planning / export iCal)", () => {
  it("busySpans distingue résa propre et blocage par liaison", () => {
    const bookings = [confirmed(1, "2026-08-10", "2026-08-12"), confirmed(3, "2026-08-20", "2026-08-22")];
    const spans = busySpans(1, bookings, LINKS, NOW);
    expect(spans).toEqual([
      { checkin: "2026-08-10", checkout: "2026-08-12", sourceUnitId: 1 },
      { checkin: "2026-08-20", checkout: "2026-08-22", sourceUnitId: 3 },
    ]);
    // Vue Domaine : les deux résas le bloquent
    expect(busySpans(3, bookings, LINKS, NOW)).toHaveLength(2);
  });

  it("mergeSpans fusionne les périodes qui se touchent ou se chevauchent", () => {
    expect(
      mergeSpans([
        { checkin: "2026-08-14", checkout: "2026-08-16" },
        { checkin: "2026-08-10", checkout: "2026-08-12" },
        { checkin: "2026-08-12", checkout: "2026-08-14" }, // touche la 1re
        { checkin: "2026-08-20", checkout: "2026-08-22" },
        { checkin: "2026-08-21", checkout: "2026-08-23" }, // chevauche
      ]),
    ).toEqual([
      { checkin: "2026-08-10", checkout: "2026-08-16" },
      { checkin: "2026-08-20", checkout: "2026-08-23" },
    ]);
  });
});
