// Routes du pilote. Historique en hash (/admin2/#/calendrier) : le serveur
// n'a qu'un fichier à servir, /admin2/index.html, sans réécriture d'URL.
// La fiche ouverte vit dans l'adresse (?resa=12) : un lien la rouvre.
import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";

import { isLoggedIn } from "./api/client";
import { Shell } from "./shell/Shell";
import { LoginPage } from "./pages/Login";
import { TodayPage } from "./pages/Today";
import { CalendarPage } from "./pages/Calendar";
import { BookingsPage } from "./pages/Bookings";
import { MessagesPage } from "./pages/Messages";
import { CleaningPage } from "./pages/Cleaning";
import { SettingsPage } from "./pages/Settings";

export interface RootSearch {
  resa?: number;
  /** message à ouvrir dans Messages */
  msg?: number;
}

const rootRoute = createRootRoute({
  component: Outlet,
  validateSearch: (s: Record<string, unknown>): RootSearch => {
    const out: RootSearch = {};
    const n = Number(s.resa);
    if (Number.isInteger(n) && n > 0) out.resa = n;
    const m = Number(s.msg);
    if (Number.isInteger(m) && m > 0) out.msg = m;
    return out;
  },
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/connexion", component: LoginPage });

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: Shell,
  beforeLoad: () => {
    if (!isLoggedIn()) throw redirect({ to: "/connexion" });
  },
});

const todayRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: TodayPage });
const calendarRoute = createRoute({ getParentRoute: () => appRoute, path: "/calendrier", component: CalendarPage });
const bookingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/reservations", component: BookingsPage });
const messagesRoute = createRoute({ getParentRoute: () => appRoute, path: "/messages", component: MessagesPage });
const cleaningRoute = createRoute({ getParentRoute: () => appRoute, path: "/menage", component: CleaningPage });
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/reglages", component: SettingsPage });

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([todayRoute, calendarRoute, bookingsRoute, messagesRoute, cleaningRoute, settingsRoute]),
]);

export function makeRouter(history = createHashHistory()) {
  return createRouter({ routeTree, history, defaultPreload: false, scrollRestoration: true });
}

export type AppRouter = ReturnType<typeof makeRouter>;
declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
