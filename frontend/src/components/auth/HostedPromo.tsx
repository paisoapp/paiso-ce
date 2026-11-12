/**
 * Points people at the hosted Paiso (paisoapp.com), which they do not have
 * to run themselves. Shown on the sign-in page
 * (`LoginPage.tsx`), the sign-up page (`RegisterPage.tsx`) and in
 * Settings > About (`AboutTab.tsx`).
 */
import { HOSTED_SIGNUP_URL, LEGAL_LINK_PROPS } from "@/lib/legal";
import { cn } from "@/lib/utils";

const COPY =
  "Get automatic bank syncing and enjoy Paiso without installing software or managing servers. We " +
  "handle the hosting, updates, and backups so you can focus on your finances.";

/** `prominent` is the Settings > About version: a larger heading and a
 *  button. The sign-in and sign-up pages keep the quieter one under their
 *  forms. */
export function HostedPromo({ className, prominent = false }: { className?: string; prominent?: boolean }) {
  if (prominent) {
    return (
      <div className={cn(
        "flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary/40 bg-primary/10 p-5",
        className,
      )}>
        <div className="min-w-0 max-w-2xl space-y-1">
          <h3 className="text-lg font-semibold">Want us to handle the hosting?</h3>
          <p className="text-sm text-muted-foreground">{COPY}</p>
        </div>
        <a href={HOSTED_SIGNUP_URL} {...LEGAL_LINK_PROPS}
          className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Try hosted Paiso
        </a>
      </div>
    );
  }
  return (
    <div className={cn("rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm", className)}>
      <p className="font-medium">Want us to handle the hosting?</p>
      <p className="mt-1 text-muted-foreground">{COPY}</p>
      <a href={HOSTED_SIGNUP_URL} {...LEGAL_LINK_PROPS}
        className="mt-2 inline-block font-medium text-primary underline underline-offset-2 hover:text-primary/80">
        Try hosted Paiso
      </a>
    </div>
  );
}
