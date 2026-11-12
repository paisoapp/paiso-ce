import { useEffect } from "react";

/**
 * The browser tab's title: "Stocks & Funds · Investments · Paiso".
 *
 * The layout names the section and a section's tab strip names the tab, each
 * from the label it already shows, so a title never disagrees with the page.
 * They render in either order, so each part is kept here and the title is
 * rebuilt whenever one changes.
 */
type Part = "section" | "tab";

const parts = new Map<Part, string>();

function apply() {
  document.title = [parts.get("tab"), parts.get("section"), "Paiso"].filter(Boolean).join(" · ");
}

export function usePageTitle(part: Part, label: string | undefined) {
  useEffect(() => {
    if (!label) return;
    parts.set(part, label);
    apply();
    return () => {
      if (parts.get(part) === label) parts.delete(part);
      apply();
    };
  }, [part, label]);
}
