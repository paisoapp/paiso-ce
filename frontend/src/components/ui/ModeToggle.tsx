import { Contrast, Monitor, Moon, Sun } from "@/lib/icons";
import { useThemeStore, type Mode } from "@/store/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { id: Mode; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "gray", label: "Gray", icon: Contrast },
  { id: "system", label: "System", icon: Monitor },
];

/**
 * Light / dark / gray / system, as a compact segmented control.
 *
 * Signed out there is no sidebar and no Settings page, so the auth screens had
 * no way to change the look at all — they simply inherited whatever the app
 * had last painted, which is what made them feel inconsistent. [issue 210]
 *
 * All four of the store's modes, so a signed-out visitor can pick the same
 * look they use in the app (gray was left out here until the sign-up redesign).
 */
export function ModeToggle({ className }: { className?: string }) {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div
      role="group"
      aria-label="Appearance"
      className={cn("inline-flex rounded-lg border border-border p-0.5 gap-0.5", className)}
    >
      {OPTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setMode(id)}
          aria-pressed={mode === id}
          title={label}
          className={cn(
            "flex items-center justify-center rounded-md p-1.5 transition-colors",
            mode === id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
