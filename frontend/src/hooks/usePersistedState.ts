import { useEffect, useState } from "react";

/** Persisted UI choice backed by localStorage (SSR-safe, falls back to default). */
export function usePersistedState<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null;
      // A value this build does not know (an older build's, a hand edit)
      // falls back to the default rather than rendering nothing.
      return stored && (!allowed || allowed.includes(stored)) ? stored : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore write failures (private mode, quota) */
    }
  }, [key, value]);
  return [value, setValue];
}
