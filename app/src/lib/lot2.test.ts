import { describe, expect, it } from "vitest";

import type { Task } from "../api/types";
import { fillTemplate } from "./templates";
import { tasksByBooking, toCleaningItem } from "./tasks";

const task = (o: Partial<Task>): Task => ({
  id: 1, propertyId: 1, unitId: 2, unitName: "La Scierie", isComposite: false, bookingId: 10, kind: "menage",
  dueDate: "2026-10-10", dueTime: "10:00", nextCheckin: null, nextCheckinTime: null, nextUnitId: null, nextUnitName: null,
  nextPersons: null, status: "a_faire", assignee: null, note: null, doneAt: null, doneBy: null, updatedAt: "", ...o,
});

describe("ménage venu du serveur", () => {
  it("serré si quelqu'un arrive le jour même", () => {
    const c = toCleaningItem(task({ nextCheckin: "2026-10-10", nextCheckinTime: "16:00", nextPersons: 4, nextUnitName: "La Scierie" }));
    expect(c).toMatchObject({ date: "2026-10-10", time: "10:00", tight: true, done: false, next: { persons: 4, checkinTime: "16:00" } });
    expect(toCleaningItem(task({ status: "fait" })).done).toBe(true);
    expect(toCleaningItem(task({})).next).toBeNull();
  });
  it("pastille : une tâche par réservation, les annulées écartées", () => {
    const m = tasksByBooking([task({ id: 1, bookingId: 10 }), task({ id: 2, bookingId: 11, status: "annule" })]);
    expect([...m.keys()]).toEqual([10]);
  });
});

describe("modèles de réponse", () => {
  const ctx = { firstName: "Claire", unitName: "La Scierie", arrival: "samedi 17 octobre", checkinTime: "16 h", checkoutTime: "10 h", balance: "450,00 €", signature: "Pré Moré" };
  it("remplit les variables", () => {
    expect(fillTemplate("Bonjour {prenom},\n{bien} vous attend {arrivee} dès {heure_arrivee}. Solde : {solde}. {signature}", ctx)).toBe(
      "Bonjour Claire,\nLa Scierie vous attend samedi 17 octobre dès 16 h. Solde : 450,00 €. Pré Moré",
    );
  });
  it("sans prénom : « Bonjour, » ; variable inconnue laissée visible", () => {
    expect(fillTemplate("Bonjour {prenom}, code {code}", { ...ctx, firstName: " " })).toBe("Bonjour, code {code}");
  });
});
