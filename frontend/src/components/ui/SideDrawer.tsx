import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { useUiPrefsStore } from "@/store/uiPrefs";

interface SideDrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
}

/** How wide every drawer opens until the user drags it: a share of the window. */
const DRAWER_DEFAULT_SHARE = 0.4;
/** Drawers open right now, oldest first. A drawer can open from inside
 *  another (a transaction from a budget category): Escape closes only
 *  the top one, and each one up opens a little narrower so the one beneath
 *  still shows. */
const openDrawers: string[] = [];
/** How much narrower each stacked drawer opens. */
const STACK_STEP_PX = 32;

/** Narrower than this and a form's two columns no longer fit side by side. */
const DRAWER_MIN_PX = 360;
/** Always leave a strip of the page showing, to click on to close. */
const DRAWER_MAX_SHARE = 0.92;
/** One press of an arrow key on the resize grip. */
const KEY_STEP_PX = 32;

/** The width in pixels for a share of this window, kept within the limits. */
function widthFor(share: number): number {
  const max = Math.floor(window.innerWidth * DRAWER_MAX_SHARE);
  return Math.min(Math.max(Math.round(window.innerWidth * share), DRAWER_MIN_PX), max);
}

export function SideDrawer({
  open,
  onClose,
  title,
  children,
}: SideDrawerProps) {
  const isMobile = useIsMobile();
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  // One width for every drawer in the app, remembered across sessions and
  // devices as a share of the window so it carries from a laptop to a wide
  // monitor. A drawer used to open at a third of the window whatever it was
  // left at, and one of them (529 plans) opened at its own size.
  const savedShare = useUiPrefsStore((s) => s.drawerWidth);
  const setSavedShare = useUiPrefsStore((s) => s.setDrawerWidth);
  const [width, setWidth] = useState(() => widthFor(savedShare ?? DRAWER_DEFAULT_SHARE));
  const widthRef = useRef(width);
  widthRef.current = width;

  // Follow the saved value (another device, or a reset) and the window size.
  useEffect(() => {
    const apply = () => setWidth(widthFor(savedShare ?? DRAWER_DEFAULT_SHARE));
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [savedShare]);

  function remember(px: number) {
    setSavedShare(Math.round((px / window.innerWidth) * 1000) / 1000);
  }

  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const panelRef = useRef<HTMLDivElement>(null);
  const touchState = useRef<{
    startX: number;
    startY: number;
    dx: number;
    /** Undecided until the first ~10px of movement, then locked as either a
     *  horizontal close-swipe or (if more vertical, or a nested element still
     *  has room to scroll left) left alone for native scrolling. */
    mode: "pending" | "closing" | "ignoring";
  } | null>(null);

  // Mount / unmount with animation
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(raf);
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 220);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Its place in the stack of open drawers, and ESC for the top one only.
  const [depth, setDepth] = useState(0);
  useEffect(() => {
    if (!open) return;
    openDrawers.push(titleId);
    setDepth(openDrawers.length - 1);
    return () => {
      const i = openDrawers.indexOf(titleId);
      if (i >= 0) openDrawers.splice(i, 1);
    };
  }, [open, titleId]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && openDrawers[openDrawers.length - 1] === titleId) onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, titleId]);

  // Left-edge drag handle
  function handleDragStart(e: React.MouseEvent) {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = width;
    e.preventDefault();

    function onMouseMove(ev: MouseEvent) {
      if (!isDragging.current) return;
      // Width grows as we drag left (clientX decreases)
      const newWidth = Math.min(
        Math.max(dragStartWidth.current + (dragStartX.current - ev.clientX), DRAWER_MIN_PX),
        Math.floor(window.innerWidth * DRAWER_MAX_SHARE)
      );
      // Close if dragged almost to the right edge
      if (window.innerWidth - ev.clientX < 80) {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        onClose();
        return;
      }
      // The ref as well as the state: the release can arrive before the next
      // render, and it is the ref the release reads to know what to save.
      widthRef.current = newWidth;
      setWidth(newWidth);
    }

    function onMouseUp() {
      const moved = isDragging.current;
      isDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Saved once, when the drag ends, not on every pixel of it.
      if (moved && widthRef.current !== dragStartWidth.current) remember(widthRef.current);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // The grip from the keyboard: arrows resize, Home goes back to the default.
  function handleGripKey(e: React.KeyboardEvent) {
    if (e.key === "Home") {
      e.preventDefault();
      setSavedShare(null);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = Math.min(
      Math.max(width + (e.key === "ArrowLeft" ? KEY_STEP_PX : -KEY_STEP_PX), DRAWER_MIN_PX),
      Math.floor(window.innerWidth * DRAWER_MAX_SHARE)
    );
    setWidth(next);
    remember(next);
  }

  // Swipe-right-to-close (mobile only). Tracked with refs + direct style
  // writes rather than state, so dragging stays smooth (no re-render per
  // touchmove) and the CSS-class-driven open/close transition is untouched
  // until the gesture actually resolves.
  const SWIPE_CLOSE_THRESHOLD = 90; // px

  function handleTouchStart(e: React.TouchEvent) {
    if (!isMobile) return;
    const t = e.touches[0];
    touchState.current = { startX: t.clientX, startY: t.clientY, dx: 0, mode: "pending" };
  }

  function handleTouchMove(e: React.TouchEvent) {
    const state = touchState.current;
    if (!state || state.mode === "ignoring") return;
    const t = e.touches[0];
    const dx = t.clientX - state.startX;
    const dy = t.clientY - state.startY;

    if (state.mode === "pending") {
      if (Math.hypot(dx, dy) < 10) return; // too small to classify yet
      const mostlyHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
      // A rightward drag that starts inside content still scrolled right
      // (scrollLeft > 0) means "scroll this table back", not "close the
      // drawer" — leave it to native scrolling until it bottoms out.
      const scrollable = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-horizontal-scroll], .overflow-x-auto"
      );
      const scrollBlocked = !!scrollable && scrollable.scrollLeft > 0;
      state.mode = mostlyHorizontal && dx > 0 && !scrollBlocked ? "closing" : "ignoring";
      if (state.mode === "ignoring") return;
    }

    // Actively closing: track the finger 1:1, with resistance past the panel width.
    e.preventDefault();
    const panelWidth = panelRef.current?.offsetWidth ?? window.innerWidth;
    state.dx = Math.min(dx, panelWidth);
    if (panelRef.current) {
      panelRef.current.style.transition = "none";
      panelRef.current.style.transform = `translateX(${state.dx}px)`;
    }
  }

  function handleTouchEnd() {
    const state = touchState.current;
    touchState.current = null;
    if (!state || state.mode !== "closing" || !panelRef.current) return;

    panelRef.current.style.transition = "";
    if (state.dx > SWIPE_CLOSE_THRESHOLD) {
      panelRef.current.style.transform = "translateX(100%)";
      setTimeout(onClose, 200);
    } else {
      panelRef.current.style.transform = "";
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        "transition-opacity duration-200",
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      )}
    >
      {/* Backdrop — click to close */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Drawer panel */}
      <div
        ref={panelRef}
        // Announced as a dialog, by its title.
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={cn(
          "relative flex flex-col bg-card border-l border-border shadow-2xl",
          "transition-transform duration-200",
          visible ? "translate-x-0" : "translate-x-full"
        )}
        style={{ width: isMobile ? "100%" : `${Math.max(width - depth * STACK_STEP_PX, DRAWER_MIN_PX)}px` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {/* Resize grip on the left edge (desktop only; full-width on phones).
            The whole edge drags, as it always did, but nothing showed that it
            could: the grip in the middle is what says so. */}
        {!isMobile && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuemin={DRAWER_MIN_PX}
            aria-valuemax={Math.floor(window.innerWidth * DRAWER_MAX_SHARE)}
            aria-valuenow={width}
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            className={cn(
              "group absolute left-0 top-0 bottom-0 w-2 -translate-x-1/2 z-10",
              "cursor-col-resize focus:outline-none"
            )}
            onMouseDown={handleDragStart}
            onDoubleClick={() => setSavedShare(null)}
            onKeyDown={handleGripKey}
          >
            <span
              className={cn(
                "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors",
                "group-hover:bg-primary/50 group-active:bg-primary/70 group-focus-visible:bg-primary/70"
              )}
            />
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-1/2 top-1/2 flex h-10 w-3 -translate-x-1/2 -translate-y-1/2",
                "items-center justify-center gap-[2px] rounded-full border border-border bg-card shadow-sm",
                "transition-colors group-hover:border-primary/60 group-focus-visible:border-primary"
              )}
            >
              <span className="h-4 w-px rounded bg-muted-foreground/60 group-hover:bg-primary" />
              <span className="h-4 w-px rounded bg-muted-foreground/60 group-hover:bg-primary" />
            </span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
          {title && (
            <div id={titleId} className="flex-1 min-w-0 text-sm font-semibold text-foreground truncate">
              {title}
            </div>
          )}
          <button
            onClick={onClose}
            className="shrink-0 p-2.5 -m-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X size={15} />
          </button>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
