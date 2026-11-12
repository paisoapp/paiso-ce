// A tab that was open through a deploy still runs the previous build. Each
// page is its own file with the build's hash in its name, so the first page
// that tab has not opened yet asks for a file the new build no longer has.
// The request fails, nothing draws, and the visitor sees a blank screen until
// they think to reload.
//
// index.html is never cached, so a reload always gets the current build. This
// does that reload for them, once.

const RELOADED_AT = "paiso-reloaded-for-build";
/** A second failure this soon after a reload is not a stale tab; reloading
 *  again would only loop. The error screen takes over and offers the choice. */
const RELOAD_ONCE_WITHIN_MS = 60_000;

let reloading = false;

/** What browsers say when a page's file cannot be fetched. Chrome, Firefox and
 *  Safari each word it differently, and Vite adds its own for stylesheets. */
const MISSING_FILE = [
  /dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /is not a valid javascript mime type/i,
];

export function isMissingBuildFile(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return MISSING_FILE.some((pattern) => pattern.test(message));
}

/** Reload to pick up the current build. Returns true when a reload is under
 *  way, false when one already happened moments ago and it did not help. */
export function reloadForNewBuild(): boolean {
  if (reloading) return true;
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < RELOAD_ONCE_WITHIN_MS) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    // No session storage means no way to know a reload already happened.
    return false;
  }
  reloading = true;
  window.location.reload();
  return true;
}

/** Vite announces every failed page or stylesheet load with this event, before
 *  the failure reaches the app. Call once, before the app draws. */
export function watchForNewBuild(): void {
  window.addEventListener("vite:preloadError", () => {
    reloadForNewBuild();
  });
}
