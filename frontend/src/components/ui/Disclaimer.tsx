/**
 * The "this is not advice" line, in one place.
 *
 * The licence disclaims any warranty, but a disclaimer buried in it is not
 * what a reader sees. `general` is the app as a whole, at the foot of every
 * page; it links to the licence (AGPL-3.0, sections 15 and 16: no warranty).
 */
import { LEGAL_LINK_PROPS, LICENSE_URL } from "@/lib/legal";
import { cn } from "@/lib/utils";

type Kind = "general";

const TEXT: Record<Kind, string> = {
  // Shown at the foot of every page.
  general:
    "Paiso provides information and tools for educational and organizational purposes only. Nothing in Paiso is a recommendation or offer to buy, sell, or hold any security or financial product, or to adopt any legal, investment, tax, or financial strategy.",
};

export function Disclaimer({
  kind = "general",
  className,
}: {
  kind?: Kind;
  className?: string;
}) {
  return (
    <p className={cn("text-[11px] leading-relaxed text-muted-foreground", className)}>
      {TEXT[kind]}
      {kind === "general" && (
        <>
          {" "}
          <a href={LICENSE_URL} {...LEGAL_LINK_PROPS} className="underline hover:text-foreground">
            License terms
          </a>
        </>
      )}
    </p>
  );
}
