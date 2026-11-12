import { Link } from "react-router-dom";
import { ChevronRight } from "@/lib/icons";
import { cn } from "@/lib/utils";

/** Hover affordance for a card whose body navigates (see `useCardClick`). */
export const clickableCardClass =
  "cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/20";

/**
 * A card's heading. With `to` it is a real link — the keyboard / screen-reader
 * path to the destination the whole card also opens on click.
 */
export function CardTitle({ title, to, className }: { title: string; to?: string; className?: string }) {
  const base = cn("text-sm font-medium text-muted-foreground truncate", className);
  if (!to) return <h2 className={base}>{title}</h2>;
  return (
    <h2 className={base}>
      <Link to={to} className="group inline-flex items-center gap-0.5 hover:text-foreground focus-visible:text-foreground">
        {title}
        <ChevronRight size={14} className="opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
      </Link>
    </h2>
  );
}
