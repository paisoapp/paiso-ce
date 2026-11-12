import { useEffect } from "react";
import { useDisplayModeStore } from "@/store/displayMode";

/** Text that names money or an account: "$1,234", "−$12.34", "$1.2M" on a
 *  chart axis, a last-four like "(1842)" or "…1842", an email address.
 *  Percentages, counts and dates stay readable, so the page keeps its shape. */
const SENSITIVE = /[$€£¥]\s?\d|\(\d{4}\)|(?:\.{3}|…|\bx|\*{2,})\d{4}\b|[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/** Mark the element that shows a sensitive piece of text. Only an attribute
 *  is added, never a wrapper: React owns these text nodes and would lose
 *  track of one that was moved. */
function mark(node: Node) {
  if (node.nodeType !== Node.TEXT_NODE || !SENSITIVE.test(node.nodeValue ?? "")) return;
  let el: Element | null = node.parentElement;
  if (!el) return;
  // A blur on an SVG <tspan> is ignored; blur the whole label instead.
  if (el.closest("svg")) el = el.closest("text") ?? el;
  if (el.closest("[data-pv-skip]")) return;
  el.setAttribute("data-pv", "");
}

function markAll(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return mark(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) mark(n);
}

/**
 * Blur mode: amounts, names and account numbers are blurred on screen, while
 * labels, percentages and the shape of every chart stay readable, so a screen
 * can be shared without showing the figures. Hovering an item shows it.
 *
 * Elements that hold a name carry `data-private` where they are drawn; money
 * and account numbers are found here, wherever they appear, because they come
 * from formatters used in hundreds of places. Nothing changes in the data.
 */
export function PrivacyBlur() {
  const mode = useDisplayModeStore((s) => s.mode);
  const on = mode === "blur";

  useEffect(() => {
    const root = document.documentElement;
    if (!on) {
      root.classList.remove("privacy-blur");
      return;
    }
    root.classList.add("privacy-blur");
    markAll(document.body);
    let queued: Node[] = [];
    let frame = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") queued.push(r.target);
        r.addedNodes.forEach((n) => queued.push(n));
      }
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          const batch = queued;
          queued = [];
          batch.forEach(markAll);
        });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      root.classList.remove("privacy-blur");
    };
  }, [on]);

  return null;
}
