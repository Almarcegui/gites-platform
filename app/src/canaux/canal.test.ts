import { describe, expect, it } from "vitest";
import { channelDeliveryText, displayName, replyHint, sourceLabel } from "./canal";

const base = { fromName: null, fromEmail: "anna@guest.airbnb.com", bookingId: 7 };

describe("messages des canaux", () => {
  it("badge : le nom du canal pour un message Beds24, sinon site ou mail", () => {
    expect(sourceLabel({ channel: "beds24", canal: "Airbnb" })).toEqual({ cls: "canal canal-airbnb", text: "Airbnb" });
    expect(sourceLabel({ channel: "beds24", canal: "Booking.com" }).cls).toContain("canal-booking");
    expect(sourceLabel({ channel: "beds24", canal: null }).text).toBe("Canal");
    expect(sourceLabel({ channel: "form", canal: null }).text).toBe("Votre site");
    expect(sourceLabel({ channel: "email", canal: null }).text).toBe("Mail");
  });

  it("la réponse à un message de canal part sur le canal, pas par mail", () => {
    expect(replyHint({ ...base, channel: "beds24", canal: "Airbnb" })).toContain("sur Airbnb");
    expect(replyHint({ ...base, channel: "email", canal: null })).toContain("par mail à anna@guest.airbnb.com");
    expect(channelDeliveryText("beds24", "Airbnb")).toBe("C'est fait. Réponse envoyée sur Airbnb.");
    expect(channelDeliveryText("stub", null)).toBeNull();
  });

  it("jamais l'adresse pseudo beds24:<id> comme nom", () => {
    expect(displayName({ fromName: null, fromEmail: "beds24:999", channel: "beds24", canal: "Vrbo" })).toBe("Voyageur Vrbo");
    expect(displayName({ fromName: "Anna", fromEmail: "x", channel: "beds24", canal: "Airbnb" })).toBe("Anna");
  });
});
