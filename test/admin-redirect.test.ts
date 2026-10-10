// Une seule adresse pour l'écran d'administration (10/10/2026) : /admin/ sert
// le nouvel écran ; l'ancienne adresse du pilote et la connexion de l'ancien
// écran redirigent.
import { describe, expect, it } from "vitest";

import { adminAddressRedirect, adminRedirectResponse } from "../src/core/admin-redirect";

describe("adminAddressRedirect", () => {
  it("renvoie /admin2 et tout ce qui est dessous vers /admin/", () => {
    for (const p of ["/admin2", "/admin2/", "/admin2/index.html", "/admin2/assets/x.js", "/Admin2/"]) expect(adminAddressRedirect(p)).toBe("/admin/");
  });

  it("renvoie la connexion de l'ancien écran vers celle du nouveau", () => {
    expect(adminAddressRedirect("/admin/login.html")).toBe("/admin/#/connexion");
  });

  it("ne touche ni l'écran lui-même, ni l'API, ni le site", () => {
    for (const p of ["/admin/", "/admin/index.html", "/admin/assets/a.js", "/api/admin/units", "/", "/book/", "/admin2x/"]) expect(adminAddressRedirect(p)).toBeNull();
  });

  it("répond en 301", () => {
    const r = adminRedirectResponse("/admin2/");
    expect(r?.status).toBe(301);
    expect(r?.headers.get("location")).toBe("/admin/");
    expect(adminRedirectResponse("/admin/")).toBeNull();
  });
});
