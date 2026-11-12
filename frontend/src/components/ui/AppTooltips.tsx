import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long the pointer rests before a tip shows, as the app's other pop-ups feel. */
const SHOW_DELAY_MS = 350;
/** Elements whose `title` is not a tooltip: frames name their content for screen readers. */
const SKIP = new Set(["IFRAME", "FRAME", "LINK", "STYLE", "META", "TITLE"]);

/**
 * Hover tips in the app's own style, everywhere.
 *
 * Elements across the app carry a `title` for their hover tip, and the
 * browser drew those in its own grey box. Mounted once at the root, this
 * moves each `title` into `data-tip` as elements appear (so the browser's
 * box never shows) and draws the tip itself: the app's card colors, border
 * and shadow, above the element (below when there is no room), after a short
 * rest. New elements are picked up as they render, so no screen has to do
 * anything but set `title`.
 *
 * The text stays available to assistive technology: an element with no text
 * of its own (an icon button) gets it as `aria-label`; one with text gets it
 * as `aria-description`.
 */
export function AppTooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<number>();
  const current = useRef<Element | null>(null);

  // Take over every `title` in the document, now and as the app renders.
  useEffect(() => {
    const adopt = (el: Element) => {
      if (SKIP.has(el.tagName) || el instanceof SVGElement) return;
      const text = el.getAttribute("title");
      if (!text) return;
      el.setAttribute("data-tip", text);
      el.removeAttribute("title");
      const named = el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
      if (!named) {
        if ((el.textContent ?? "").trim()) el.setAttribute("aria-description", text);
        else el.setAttribute("aria-label", text);
      }
    };
    document.querySelectorAll("[title]").forEach(adopt);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes" && r.target instanceof Element) adopt(r.target);
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          if (n.hasAttribute("title")) adopt(n);
          n.querySelectorAll("[title]").forEach(adopt);
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
    return () => observer.disconnect();
  }, []);

  // Show the tip of whatever the pointer rests on.
  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === current.current) return;
      hide();
      if (!el) return;
      current.current = el;
      timer.current = window.setTimeout(() => {
        const text = el.getAttribute("data-tip");
        if (!text || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const below = r.top < 56;
        setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      }, SHOW_DELAY_MS);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      window.clearTimeout(timer.current);
    };
  }, []);

  if (!tip) return null;
  // Kept on screen: centred on the element, clamped to the window's edges.
  const width = Math.min(280, window.innerWidth - 16);
  const left = Math.max(8, Math.min(tip.x - width / 2, window.innerWidth - width - 8));
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] flex justify-center"
      style={{ left, width, top: tip.y, transform: tip.below ? undefined : "translateY(-100%)" }}
    >
      <div className="max-w-full whitespace-pre-line rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-card-foreground shadow-lg">
        {tip.text}
      </div>
    </div>,
    document.body,
  );
}
