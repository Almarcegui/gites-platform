// Historique des échanges d'un client (écran Réglages › Clients) :
//   GET /api/admin/guests/:id/history   mails envoyés + messages reçus ou écrits, par séjour
// Mêmes contrôles d'accès que les autres routes du back-office (guard).
import { guestHistory } from "../services/guest-history";
import { guard } from "./admin";
import { apiError, json, type Router } from "./router";

export function registerHistoryRoutes(router: Router): void {
  router.get("/api/admin/guests/:id/history", guard(async (_req, env, p) => {
    const id = Number(p.id);
    if (!Number.isInteger(id) || id <= 0) return apiError(400, "client invalide");
    const history = await guestHistory(env.DB, id);
    if (!history) return apiError(404, "client inconnu");
    return json(history);
  }));
}
