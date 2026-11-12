import { useMemo, useState } from "react";
import { Popover } from "@/pages/Budgeting/budget/Popover";
import { cn } from "@/lib/utils";

/** Emoji for money categories, each with the words a search matches. */
const EMOJI: [string, string][] = [
  ["💰", "money income bag"], ["💵", "cash salary paycheck dollar"], ["💸", "fees charges spending money"],
  ["🪙", "coin other income"], ["💳", "credit card payment"], ["🏦", "bank loan"], ["📈", "investment income growth dividend"],
  ["📊", "investments chart"], ["💼", "business freelance work job"], ["🧾", "receipt expense bill"], ["🔁", "transfer repeat"],
  ["🔄", "subscription recurring"], ["🐷", "savings piggy"], ["🏖️", "retirement vacation beach"], ["↩️", "refund return"], ["🔙", "reimbursement back repaid"], ["↔️", "transfer between accounts move"],
  ["🏠", "home housing rent house"], ["🏡", "mortgage home house"], ["🔑", "rent keys landlord"], ["🛠️", "repairs maintenance tools"],
  ["🛋️", "furniture home"], ["🧹", "cleaning household"], ["💡", "utilities electric power light"], ["💧", "water utilities"],
  ["🔥", "gas heating utilities"], ["🌐", "internet wifi"], ["📱", "phone mobile cell"], ["📺", "tv streaming cable"],
  ["🛒", "groceries supermarket food shopping"], ["🍽️", "restaurants dining food"], ["☕", "coffee cafe"], ["🍔", "fast food takeout"],
  ["🍕", "pizza takeout food"], ["🍺", "bar drinks alcohol"], ["🍷", "wine drinks alcohol"], ["🧁", "treats bakery dessert"],
  ["🚗", "car auto transportation"], ["⛽", "gas fuel petrol"], ["🅿️", "parking"], ["🚌", "bus transit transportation"],
  ["🚆", "train transit commute"], ["🚕", "taxi rideshare uber lyft"], ["🚲", "bike bicycle"], ["🛞", "tires car service"],
  ["✈️", "travel flights vacation"], ["🏨", "hotel lodging travel"], ["🧳", "luggage travel trip"], ["🗺️", "travel trips"],
  ["🛍️", "shopping retail"], ["👕", "clothing clothes apparel"], ["👟", "shoes sneakers"], ["💄", "beauty makeup cosmetics"],
  ["💇", "personal care hair salon"], ["💅", "nails beauty salon"], ["🧴", "toiletries personal care"], ["💎", "jewelry"],
  ["🩺", "health medical doctor"], ["💊", "pharmacy medicine prescription"], ["🦷", "dental dentist teeth"], ["👓", "vision glasses optical"],
  ["🏥", "hospital medical"], ["💪", "gym fitness exercise"], ["🧘", "yoga wellness"], ["🧠", "therapy mental health"],
  ["🎬", "entertainment movies"], ["🎵", "music concerts"], ["🎮", "games gaming"], ["🎟️", "tickets events"],
  ["📚", "books reading"], ["🎓", "education school tuition college"], ["✏️", "school supplies"], ["🧸", "kids children toys"],
  ["👶", "baby childcare daycare"], ["🐾", "pets pet animal"], ["🐶", "dog pet"], ["🐱", "cat pet"],
  ["🎁", "gifts presents"], ["🤝", "charity donations giving"], ["⛪", "church tithe religion"], ["💍", "wedding"],
  ["🎉", "party celebration bonus"], ["🎂", "birthday"], ["🎄", "holiday christmas"], ["🌱", "garden plants"],
  ["🏛️", "taxes government"], ["🛡️", "insurance protection"], ["⚖️", "legal lawyer"], ["📮", "postage shipping mail"],
  ["📦", "other misc packages"], ["🖥️", "computer software tech"], ["☁️", "cloud storage software"], ["🔧", "tools hardware"],
  ["🧑‍💼", "work office professional"], ["🗂️", "group folder"], ["🏷️", "tag other label"], ["❓", "uncategorized unknown"],
];

/**
 * Pick an emoji for a category or group: a button showing the current
 * one opens a pop-up with a search box ("coffee", "car", "gym") and the set
 * of money-related emoji. Leaving it empty lets Paiso pick from the name.
 */
export function EmojiPicker({ value, onChange, clearable = false, suggested }: {
  value: string;
  onChange: (v: string) => void;
  /** Offer "let Paiso pick": only when creating, where an empty emoji is filled from the name. */
  clearable?: boolean;
  /** What Paiso would pick from the name, shown while `value` is empty. */
  suggested?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? EMOJI.filter(([, words]) => words.includes(q)) : EMOJI;
  }, [query]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}
      align="left"
      width="md:w-80"
      label="Choose an emoji"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted"
        >
          <span className="text-xl leading-none">{value || suggested || "🏷️"}</span>
          <span className="text-muted-foreground">{value ? "Change" : suggested ? "Picked from the name. Change" : "Choose"}</span>
        </button>
      }
    >
      <div className="space-y-2">
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search, e.g. coffee, car, gym"
          aria-label="Search emoji"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        <div className="flex flex-wrap gap-1 max-h-56 overflow-y-auto" role="listbox" aria-label="Emoji">
          {shown.map(([e, words]) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={value === e}
              aria-label={words.split(" ")[0]}
              title={words.split(" ")[0]}
              onClick={() => { onChange(e); setOpen(false); setQuery(""); }}
              className={cn("h-9 w-9 rounded-md text-lg transition-colors hover:bg-muted", value === e && "bg-primary/10 ring-2 ring-primary/40")}
            >
              {e}
            </button>
          ))}
          {shown.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No emoji match "{query}".</p>}
        </div>
        {clearable && value && (
          <button type="button" onClick={() => { onChange(""); setOpen(false); }}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
            Clear, and let Paiso pick from the name
          </button>
        )}
      </div>
    </Popover>
  );
}
