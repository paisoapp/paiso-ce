import { useEffect, useState } from "react";
import { isNewAccount, useMe, type Me } from "@/hooks/useMe";

/** When this browser last opened the dashboard, to tell a return after a
 *  break from a visit an hour ago. Per browser on purpose: it only picks
 *  between two friendly lines, so it is not worth a stored preference. */
const LAST_VISIT_KEY = "paiso-dashboard-last-visit";
/** Away at least this long and the greeting says "Welcome back". */
const AWAY_DAYS = 3;

function readLastVisit(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_VISIT_KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function writeLastVisit(at: number) {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(at));
  } catch {
    // Private windows and blocked storage: the greeting falls back to the hour.
  }
}

/** "Good morning" and so on by the viewer's own clock; "Hello" through the
 *  small hours, when "Good evening" reads oddly. */
function timeOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Hello";
}

/**
 * The line the dashboard opens with: the time of day and the user's
 * first name, "Welcome" in an account's first days, and "Welcome back" after
 * a few days away. With no first name on the account it greets without one.
 */
function greetingFor(me: Me | undefined, now: Date, lastVisit: number | null): string {
  const first = me?.first_name?.trim();
  const name = first ? `, ${first}` : "";
  if (me && isNewAccount(me) && lastVisit === null) return `Welcome${name}`;
  if (lastVisit !== null && now.getTime() - lastVisit >= AWAY_DAYS * 86_400_000) return `Welcome back${name}`;
  return `${timeOfDay(now.getHours())}${name}`;
}

export function DashboardGreeting() {
  const { data: me } = useMe();
  // Read once per mount, before this visit is recorded, so the greeting does
  // not flip from "Welcome back" to "Good evening" on the next render.
  const [lastVisit] = useState(readLastVisit);
  useEffect(() => writeLastVisit(Date.now()), []);
  return <h1 className="text-2xl font-bold">{greetingFor(me, new Date(), lastVisit)}</h1>;
}
