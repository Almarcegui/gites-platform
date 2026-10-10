import { useMediaQuery } from "@mantine/hooks";

/** « A » à l'ordinateur (900 px et plus), « B » au téléphone. Mêmes routes,
 *  mêmes données : seule la disposition change. */
export function useLayout(): "A" | "B" {
  const wide = useMediaQuery("(min-width: 900px)", typeof window !== "undefined" ? window.innerWidth >= 900 : true, {
    getInitialValueInEffect: false,
  });
  return wide ? "A" : "B";
}
