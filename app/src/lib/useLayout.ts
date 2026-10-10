import { useMediaQuery } from "@mantine/hooks";

/** « A » à l'ordinateur (1024 px et plus : la barre latérale), « B » au téléphone. Mêmes routes,
 *  mêmes données : seule la disposition change. */
export function useLayout(): "A" | "B" {
  const wide = useMediaQuery("(min-width: 1024px)", typeof window !== "undefined" ? window.innerWidth >= 1024 : true, {
    getInitialValueInEffect: false,
  });
  return wide ? "A" : "B";
}
