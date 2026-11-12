import { useSyncExternalStore } from "react";

/** Reactively track a CSS media query. */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// Matches Tailwind's `md` breakpoint: structural swaps (table→card,
// dialog→sheet) happen below md; the sidebar breakpoint stays `lg`.
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
