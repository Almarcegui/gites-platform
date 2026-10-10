import { I18nProvider } from "@lingui/react";
import { localStorageColorSchemeManager, MantineProvider, useComputedColorScheme } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { onUnauthorized } from "./api/client";
import { i18n } from "./i18n";
import { ScopeProvider } from "./lib/scope";
import { ToastProvider } from "./lib/toasts";
import type { AppRouter } from "./router";
import { theme } from "./theme";

// Thème : clair par défaut, quoi que dise le téléphone (retour de Julien du
// 10/10 : le pilote s'ouvrait sombre sur un iPhone en mode sombre). Le choix
// clair/sombre se fait dans Réglages et reste sur l'appareil (localStorage).
export const THEME_KEY = "gp2_theme";
const colorSchemeManager = localStorageColorSchemeManager({ key: THEME_KEY });

/** Les champs natifs (dates, listes) suivent le thème choisi, pas celui du système. */
function ThemeMeta() {
  const scheme = useComputedColorScheme("light");
  useEffect(() => {
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", scheme);
  }, [scheme]);
  return null;
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: (n, e) => n < 1 && !(e && typeof e === "object" && "status" in e && (e as { status: number }).status < 500), refetchOnWindowFocus: true, staleTime: 15_000 },
    },
  });
}

export function App({ router, queryClient }: { router: AppRouter; queryClient?: QueryClient }) {
  const [qc] = useState(() => queryClient ?? makeQueryClient());
  useEffect(() => onUnauthorized(() => void router.navigate({ to: "/connexion" })), [router]);
  return (
    <I18nProvider i18n={i18n}>
      <MantineProvider theme={theme} defaultColorScheme="light" colorSchemeManager={colorSchemeManager}>
        <ThemeMeta />
        <QueryClientProvider client={qc}>
          <ScopeProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ScopeProvider>
        </QueryClientProvider>
      </MantineProvider>
    </I18nProvider>
  );
}
