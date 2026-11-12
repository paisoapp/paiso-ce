import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Redo2, Undo2 } from "lucide-react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { DraftStep } from "./budgetDraft";

/**
 * The Budget tab's unsaved changes: how many, the last one,
 * Undo and Redo (also Ctrl or Cmd+Z and Shift+Ctrl or Cmd+Z), Discard and
 * Save. It stays at the foot of the window while the tables scroll; on a
 * phone it sits above the tab bar.
 */
export function DraftBar({ steps, canRedo, saving, error, onUndo, onRedo, onDiscard, onSave }: {
  steps: DraftStep[];
  canRedo: boolean;
  saving: boolean;
  error: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      // Typing in a field keeps the field's own undo.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) onRedo();
      else onUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo, onRedo]);

  if (steps.length === 0 && !canRedo) return null;
  const last = steps[steps.length - 1];
  const btn = "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-40";
  return (
    <div
      role="region"
      aria-label="Unsaved budget changes"
      // Sticky at the foot of the tab's own column, so it stays in reach while
      // the tables scroll and never sits over the sidebar.
      // (The scroll area already ends above the phone's tab bar.)
      className="sticky bottom-3 md:bottom-4 z-30 flex justify-center"
    >
      <div className="w-full max-w-2xl rounded-xl border border-primary/40 bg-card shadow-xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex-1 min-w-[10rem] text-sm">
            <p className="font-medium">
              {steps.length === 0 ? "No unsaved changes" : `${steps.length} unsaved change${steps.length === 1 ? "" : "s"}`}
            </p>
            {last && <p className="text-xs text-muted-foreground truncate">Last: {last.label}</p>}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="flex w-full sm:w-auto items-center justify-end gap-1.5">
            <button type="button" onClick={onUndo} disabled={steps.length === 0 || saving} className={btn} title="Undo (Ctrl or Cmd+Z)" aria-label="Undo">
              <Undo2 size={14} /> <span className="hidden sm:inline">Undo</span>
            </button>
            <button type="button" onClick={onRedo} disabled={!canRedo || saving} className={btn} title="Redo (Shift+Ctrl or Cmd+Z)" aria-label="Redo">
              <Redo2 size={14} /> <span className="hidden sm:inline">Redo</span>
            </button>
            <button type="button" onClick={onDiscard} disabled={steps.length === 0 || saving} className={btn}>
              Discard
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={steps.length === 0 || saving}
              className="whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Keeps unsaved changes from being lost by accident: the browser asks before
 * the page is closed or reloaded, and a link inside the app opens a dialog
 * that asks first. `ask` lets the tab's own controls (month, settings,
 * another budget) use the same dialog.
 */
export function useLeaveGuard(dirty: boolean, discard: () => void) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<null | (() => void)>(null);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.origin !== window.location.origin) return;
      e.preventDefault();
      e.stopPropagation();
      const to = a.pathname + a.search + a.hash;
      setPending(() => () => navigate(to));
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, navigate]);

  const ask = (then: () => void) => (dirty ? setPending(() => then) : then());
  const dialog = (
    <Dialog open={pending !== null} onClose={() => setPending(null)} className="md:max-w-md">
      <DialogHeader onClose={() => setPending(null)}>Leave without saving?</DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          Your changes to this budget are not saved yet. Leaving drops them.
        </p>
      </DialogBody>
      <DialogFooter>
        <button type="button" onClick={() => setPending(null)}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          Stay
        </button>
        <button type="button"
          onClick={() => { const go = pending; setPending(null); discard(); go?.(); }}
          className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90">
          Discard and leave
        </button>
      </DialogFooter>
    </Dialog>
  );
  return { ask, dialog };
}
