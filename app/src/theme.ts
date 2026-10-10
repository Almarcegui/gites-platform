import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Vert sapin en teinte 6 (#1F5A4A), seule couleur d'accent. IBM Plex Sans,
// comme Greffe. Les tailles de texte et de champ passent par des variables :
// 14 px à l'ordinateur, 16 px au téléphone (cf. styles.css, « densité »).
const sapin: MantineColorsTuple = [
  "#E3EFEA", "#CFE2DA", "#A9CCBE", "#7FB3A0", "#559A84", "#2F7C66", "#1F5A4A", "#18483B", "#12382E", "#0C2820",
];

export const theme = createTheme({
  primaryColor: "sapin",
  primaryShade: { light: 6, dark: 5 },
  colors: { sapin },
  black: "#1A2230",
  fontFamily: "var(--police)",
  headings: { fontFamily: "var(--police-titres)", fontWeight: "600" },
  fontSizes: { xs: "var(--fs-xs)", sm: "var(--fs-sm)", md: "var(--fs-md)", lg: "var(--fs-lg)", xl: "var(--fs-xl)" },
  radius: { xs: "3px", sm: "4px", md: "6px", lg: "8px", xl: "10px" },
  defaultRadius: "sm",
  cursorType: "pointer",
  focusRing: "auto",
});
