import { i18n } from "@lingui/core";

import { messages } from "./locales/fr/messages.po";

// Textes de l'écran en français (langue source). Le catalogue compilé est
// chargé même pour elle : en build, Lingui retire les textes du code et ne
// garde que leurs identifiants. Le néerlandais viendra avec son catalogue.
i18n.load("fr", messages);
i18n.activate("fr");

export { i18n };
