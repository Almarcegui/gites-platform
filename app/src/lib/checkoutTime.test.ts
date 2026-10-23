import { describe, expect, it } from "vitest";
import { checkoutTimeFor } from "./checkoutTime";

// 25/10/2026 est un dimanche.
describe("checkoutTimeFor (back-office)", () => {
  const s = { checkoutTime: "10:00", checkoutTimeSunday: "18:00" };
  it("dimanche : l'heure du dimanche, autre jour : l'heure commune", () => {
    expect(checkoutTimeFor(s, "2026-10-25")).toBe("18:00");
    expect(checkoutTimeFor(s, "2026-10-26")).toBe("10:00");
    expect(checkoutTimeFor(s, "2026-10-24")).toBe("10:00");
  });
  it("réglage vide ou absent, date absente : l'heure commune", () => {
    expect(checkoutTimeFor({ checkoutTime: "10:00", checkoutTimeSunday: "" }, "2026-10-25")).toBe("10:00");
    expect(checkoutTimeFor({ checkoutTime: "10:00" }, "2026-10-25")).toBe("10:00");
    expect(checkoutTimeFor(s, undefined)).toBe("10:00");
  });
});
