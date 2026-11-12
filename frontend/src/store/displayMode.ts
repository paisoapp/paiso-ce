import { create } from "zustand";
import { persist } from "zustand/middleware";

/** "temu" is privacy mode (values ÷ 100); the stored names are kept so a
 *  saved choice survives the rename. "blur" blurs amounts and names. */
export type DisplayMode = "regular" | "temu" | "blur";

const STORAGE_KEY = "paiso-display-mode";

interface DisplayModeStore {
  mode: DisplayMode;
  setMode: (mode: DisplayMode) => void;
}

export const useDisplayModeStore = create<DisplayModeStore>()(
  persist(
    (set) => ({
      mode: "regular",
      setMode: (mode) => set({ mode }),
    }),
    { name: STORAGE_KEY }
  )
);

/** Read the current display scale without a hook — safe to call from formatCurrency. */
export function getDisplayScale(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const { state } = JSON.parse(raw) as { state: { mode: DisplayMode } };
      return state?.mode === "temu" ? 0.01 : 1;
    }
  } catch {
    // ignore
  }
  return 1;
}
