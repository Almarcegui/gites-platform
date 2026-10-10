import "@fontsource/schibsted-grotesk/latin-400.css";
import "@fontsource/schibsted-grotesk/latin-600.css";
import "@fontsource/schibsted-grotesk/latin-700.css";
import "@fontsource/schibsted-grotesk/latin-800.css";
import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/literata/latin-600.css";
import "@mantine/core/styles.layer.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { makeRouter } from "./router";

const racine = document.getElementById("racine");
if (!racine) throw new Error("La page n'a pas de racine où poser l'écran.");
createRoot(racine).render(
  <StrictMode>
    <App router={makeRouter()} />
  </StrictMode>,
);
