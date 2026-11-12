import { useEffect, useState } from "react";
import { Check, Plus, Search, Sparkles, X } from "@/lib/icons";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABELS, WIDGETS, WIDGETS_BY_ID,
  type Recommendation, type WidgetCategory, type WidgetDef,
} from "./widgets/registry";

const KIND_LABEL: Record<WidgetDef["kind"], string> = { card: "Card", chart: "Chart", table: "Table" };

/** Whether a widget matches what was typed: every word has to appear
 *  in its title, description, section or kind, in any order. */
function matches(def: WidgetDef, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${def.title} ${def.description} ${CATEGORY_LABELS[def.category]} ${KIND_LABEL[def.kind]}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

export function AddWidgetDialog({
  open,
  onClose,
  placed,
  recommendations,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  placed: Set<string>;
  recommendations: Recommendation[];
  onAdd: (id: string) => void;
}) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  // Each time the dialog opens, it starts with every widget listed.
  useEffect(() => { if (open) setQuery(""); }, [open]);
  const searching = query.trim().length > 0;
  const available = WIDGETS.filter((w) => !searching || matches(w, query));
  const categories = Object.keys(CATEGORY_LABELS) as WidgetCategory[];

  return (
    <Dialog open={open} onClose={onClose} className="md:max-w-2xl">
      <DialogHeader onClose={onClose}>Add widgets</DialogHeader>
      <DialogBody className="space-y-5">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-primary/50">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Not on a phone, where focusing would cover the list with the keyboard.
            autoFocus={!isMobile}
            placeholder="Search widgets, e.g. bills, budget, net worth"
            aria-label="Search widgets"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm placeholder:text-muted-foreground focus:outline-none"
          />
          {searching && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear the search"
              className="shrink-0 text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          )}
        </div>
        {searching && available.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No widgets match “{query.trim()}”.</p>
        )}
        {/* While searching, the matches are listed by section only, so a
            recommended widget is not shown twice. */}
        {!searching && recommendations.length > 0 && (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary mb-2">
              <Sparkles size={13} /> Recommended for you
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {recommendations.map((r) => (
                <WidgetOption
                  key={r.id}
                  def={WIDGETS_BY_ID[r.id]}
                  note={r.reason}
                  added={placed.has(r.id)}
                  onAdd={() => onAdd(r.id)}
                  highlight
                />
              ))}
            </div>
          </section>
        )}
        {categories.map((cat) => {
          const defs = available.filter((w) => w.category === cat);
          if (defs.length === 0) return null;
          return (
            <section key={cat}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {CATEGORY_LABELS[cat]}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {defs.map((def) => (
                  <WidgetOption key={def.id} def={def} added={placed.has(def.id)} onAdd={() => onAdd(def.id)} />
                ))}
              </div>
            </section>
          );
        })}
      </DialogBody>
    </Dialog>
  );
}

function WidgetOption({
  def,
  note,
  added,
  onAdd,
  highlight,
}: {
  def: WidgetDef;
  note?: string;
  added: boolean;
  onAdd: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={added}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        highlight ? "border-primary/40 bg-primary/5" : "border-border",
        added ? "opacity-60 cursor-default" : "hover:bg-muted/60",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium flex items-center gap-2">
          {def.title}
          <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {KIND_LABEL[def.kind]}
          </span>
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{note ?? def.description}</p>
      </div>
      <span
        className={cn(
          "shrink-0 inline-flex items-center gap-1 text-xs font-medium rounded-md px-2 py-1",
          added ? "text-muted-foreground" : "text-primary",
        )}
      >
        {added ? <><Check size={13} /> Added</> : <><Plus size={13} /> Add</>}
      </span>
    </button>
  );
}
