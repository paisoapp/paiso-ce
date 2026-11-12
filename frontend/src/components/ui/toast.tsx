/**
 * Toasts — the app's first transient-feedback surface.
 *
 * Before this, feedback was inline `<p className="text-destructive">` in two
 * font sizes, two `window.alert()` calls, and a handful of mutations that
 * failed in total silence. Inline text works when the control and the message
 * share a screen; it does not when the mutation fires from a drawer, a row
 * action, or a background invalidation.
 *
 * The store is deliberately outside React so `toast()` can be called from a
 * react-query `onError` (which is not a component) without threading a hook
 * through every caller. `<Toaster/>` is mounted once in App.tsx.
 */
import * as RadixToast from "@radix-ui/react-toast";
import { create } from "zustand";
import { CheckCircle, AlertTriangle, Info, X } from "@/lib/icons";
import { cn } from "@/lib/utils";

type ToastVariant = "default" | "success" | "error";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** ms before auto-dismiss; errors stay until dismissed. */
  duration: number;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

interface ToastOptions {
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

/** Show a toast. Callable from anywhere — components, query callbacks, plain
 *  functions. Errors persist until dismissed; everything else auto-hides. */
export function toast(title: string, opts: ToastOptions = {}) {
  const variant = opts.variant ?? "default";
  return useToastStore.getState().push({
    title,
    description: opts.description,
    variant,
    duration: opts.duration ?? (variant === "error" ? Infinity : 4000),
  });
}

/** Convenience wrapper for a failed mutation: `onError: toastError("Save failed")`. */
export function toastError(title: string) {
  return (e: unknown) =>
    toast(title, {
      description: e instanceof Error ? e.message : String(e),
      variant: "error",
    });
}

const variantStyles: Record<ToastVariant, string> = {
  default: "border-border",
  success: "border-success/40",
  error: "border-destructive/50",
};

const variantIcon: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CheckCircle,
  error: AlertTriangle,
};

const iconTone: Record<ToastVariant, string> = {
  default: "text-muted-foreground",
  success: "text-success",
  error: "text-destructive",
};

/** Mount once, near the root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <RadixToast.Provider swipeDirection="right">
      {toasts.map((t) => {
        const Icon = variantIcon[t.variant];
        return (
          <RadixToast.Root
            key={t.id}
            duration={t.duration === Infinity ? undefined : t.duration}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            className={cn(
              "flex items-start gap-3 rounded-lg border bg-card p-3 shadow-lg",
              "data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out",
              variantStyles[t.variant],
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconTone[t.variant])} />
            <div className="min-w-0 flex-1">
              <RadixToast.Title className="text-sm font-medium text-foreground">
                {t.title}
              </RadixToast.Title>
              {t.description && (
                <RadixToast.Description className="mt-0.5 break-words text-xs text-muted-foreground">
                  {t.description}
                </RadixToast.Description>
              )}
            </div>
            <RadixToast.Close
              aria-label="Dismiss"
              className="rounded p-1 -m-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </RadixToast.Close>
          </RadixToast.Root>
        );
      })}
      <RadixToast.Viewport
        className={cn(
          "fixed z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 outline-none",
          // Above the mobile safe area; bottom-right on desktop.
          "bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4",
        )}
      />
    </RadixToast.Provider>
  );
}
