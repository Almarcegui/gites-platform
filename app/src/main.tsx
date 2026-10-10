import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@mantine/core/styles.layer.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { checkOfflineCacheOwner } from "./api/client";
import { makeRouter } from "./router";

checkOfflineCacheOwner();
const racine = document.getElementById("racine");
if (!racine) throw new Error("La page n'a pas de racine où poser l'écran.");
createRoot(racine).render(
  <StrictMode>
    <App router={makeRouter()} />
  </StrictMode>,
);

// PWA (lot 2) : le service worker ne s'installe que sur l'écran construit
// (pas en développement, où il garderait de vieilles versions des modules).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => undefined);
  });
}
