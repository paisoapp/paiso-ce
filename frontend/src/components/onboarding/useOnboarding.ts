import { useUiPrefsStore } from "@/store/uiPrefs";
import type { OnboardingAnswers, OnboardingState } from "@/store/uiPrefs";

/**
 * Thin accessor over the onboarding slice of the uiPrefs store. Keeps the
 * store's shape an implementation detail so components read state + a small
 * set of intent-named actions.
 */
export function useOnboarding() {
  const onboarding = useUiPrefsStore((s) => s.onboarding);
  const setOnboarding = useUiPrefsStore((s) => s.setOnboarding);

  const patch = (p: Partial<OnboardingState>) => setOnboarding(p);

  return {
    ...onboarding,
    /** Mark the flow active. Leaves the position alone: the wizard works out
     *  where the user is from what they have done, not from a saved index. */
    start: () => patch({ status: "active" }),
    /** User chose to explore on their own. */
    dismiss: () => patch({ status: "dismissed" }),
    /** Re-open the guide (from Settings) after dismissal/completion. */
    restart: () => patch({ status: "active", guideMinimized: false }),
    complete: () => patch({ status: "completed" }),
    setStep: (currentStep: number) => patch({ currentStep }),
    /** Save the "what brings you here" answers. */
    // Merged onto the store's current answers, not this render's copy: two
    // picks made before the next render would otherwise each start from the
    // same stale answers, and the second would erase the first.
    setAnswers: (answers: Partial<OnboardingAnswers>) =>
      patch({
        answers: {
          goals: [],
          ...useUiPrefsStore.getState().onboarding.answers,
          ...answers,
        },
      }),
    setMinimized: (guideMinimized: boolean) => patch({ guideMinimized }),
    /** Mark a step id explicitly done or skipped (idempotent). */
    markStepDone: (id: string) =>
      patch({
        completedSteps: onboarding.completedSteps.includes(id)
          ? onboarding.completedSteps
          : [...onboarding.completedSteps, id],
      }),
    /** Record that a one-time contextual tip has been seen (idempotent). */
    markTipSeen: (id: string) =>
      patch({
        seenTips: onboarding.seenTips.includes(id)
          ? onboarding.seenTips
          : [...onboarding.seenTips, id],
      }),
  };
}
