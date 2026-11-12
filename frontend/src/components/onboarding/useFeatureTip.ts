import { useOnboarding } from "./useOnboarding";

/**
 * Drives a single one-time contextual tip. `shouldShow` is true only when the
 * tip hasn't been dismissed before AND the caller says the surrounding context
 * is ready (`enabled` — e.g. there's data on the page to point at). Callers pass
 * a stable `id`; dismissal is persisted in `ui_prefs.onboarding.seenTips`.
 */
export function useFeatureTip(id: string, enabled = true) {
  const { seenTips, markTipSeen } = useOnboarding();
  const shouldShow = enabled && !seenTips.includes(id);
  return {
    shouldShow,
    dismiss: () => markTipSeen(id),
  };
}
