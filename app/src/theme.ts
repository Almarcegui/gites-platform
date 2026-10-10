import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Le vert sapin des maquettes (#2C5A4B en teinte 6). Les polices suivent la
// disposition : Schibsted Grotesk à l'ordinateur (maquette A), Atkinson
// Hyperlegible et Literata au téléphone (maquette B) — cf. styles.css.
const sapin: MantineColorsTuple = [
  "#E6F0EB", "#DCEAE3", "#B7D3C6", "#8FB8A6", "#6A9E88", "#4A846E", "#2C5A4B", "#244B3E", "#1C3C32", "#142D25",
];

export const theme = createTheme({
  primaryColor: "sapin",
  primaryShade: { light: 6, dark: 5 },
  colors: { sapin },
  fontFamily: "var(--police)",
  headings: { fontFamily: "var(--police-titres)", fontWeight: "700" },
  fontSizes: { xs: "0.8125rem", sm: "0.9375rem", md: "1rem", lg: "1.125rem", xl: "1.25rem" },
  radius: { xs: "6px", sm: "8px", md: "10px", lg: "14px", xl: "18px" },
  defaultRadius: "md",
  cursorType: "pointer",
  focusRing: "auto",
});
