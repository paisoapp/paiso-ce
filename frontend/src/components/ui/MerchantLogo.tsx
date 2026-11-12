import { cn } from "@/lib/utils";

/**
 * A monogram in front of a transaction description: the first letter of the
 * merchant or description in a neutral circle, so descriptions stay aligned.
 */
export function MerchantLogo({
  name,
  size = 20,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const letter = (name ?? "").trim().replace(/^[^A-Za-z0-9]+/, "").charAt(0).toUpperCase();
  const box = { width: size, height: size };
  return (
    <span
      aria-hidden="true"
      style={{ ...box, fontSize: Math.round(size * 0.5) }}
      className={cn(
        "shrink-0 inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground font-semibold",
        className,
      )}
    >
      {letter || "·"}
    </span>
  );
}
