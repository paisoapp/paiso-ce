// Declarative config for the setup wizard. The wizard is a thin renderer over
// this list; each step's completion is derived from the user's real data (see
// OnboardingData) so the guide reflects reality even when a user wanders off
// into manual mode. Explicit "Skip" also marks a step done.

export interface OnboardingData {
  /** Name and date of birth saved on the profile. */
  hasProfile: boolean;
  /** They said what they came to do. */
  hasGoals: boolean;
  /** They said how they manage money today and what they have. */
  hasFinances: boolean;
  accountCount: number;
  /** Any investment holding or tracked asset (property, vehicle, valuables). */
  hasAssets: boolean;
  /** Any liability-type account (credit card, loan, mortgage) or asset loan. */
  hasLiabilities: boolean;
  /** A mortgage with no property linked to it: the assets step then
   *  suggests adding that home first. */
  mortgageWithoutHome?: boolean;
  /** At least one transaction assigned to a category. */
  hasCategorized: boolean;
  budgetEnrolled: boolean;
}

export interface StepLink {
  label: string;
  route: string;
}

export interface OnboardingStep {
  id: string;
  title: string;
  blurb: string;
  /** Primary "Go to…" target, for steps that hand off to an app page. */
  route?: string;
  cta?: string;
  /** Open this drawer for the primary action instead of leaving the wizard,
   *  as the accounts step does with Add an account. */
  ctaDrawer?: "holding";
  /** Optional secondary destinations (e.g. property / other assets). */
  extraLinks?: StepLink[];
  /** One of the optional follow-ups after the snapshot. These are reordered
   *  to put what the user came for first. */
  guide?: boolean;
  /** Worth offering, never owed: it does not count towards finishing setup,
   *  and the wizard can be finished from it without doing it. */
  optional?: boolean;
  /** Mandatory step: no "Skip this step", and later steps stay locked until
   *  it is done. */
  required?: (d: OnboardingData) => boolean;
  isComplete: (d: OnboardingData) => boolean;
}

/** The parts of the user's answers that decide the order of the guide. */
interface StepAnswers {
  goals?: string[];
  have?: string[];
}

/** Which optional steps each stated goal makes more urgent. */
const GOAL_STEPS: Record<string, string[]> = {
  spending: ["categorize"],
  net_worth: ["assets", "liabilities"],
  investments: ["assets"],
  budget: ["categorize", "budget"],
};

/** And which ones the things they have make relevant. */
const HAVE_STEPS: Record<string, string[]> = {
  brokerage: ["assets"],
  real_estate: ["assets"],
  credit_cards: ["liabilities"],
};

/** The steps after the snapshot are a to-do list, not a sequence, so the ones
 *  that serve what the user told us go first. Stable otherwise. */
function orderByAnswers(steps: OnboardingStep[], answers: StepAnswers): OnboardingStep[] {
  const wanted = new Set([
    ...(answers.goals ?? []).flatMap((g) => GOAL_STEPS[g] ?? []),
    ...(answers.have ?? []).flatMap((h) => HAVE_STEPS[h] ?? []),
  ]);
  if (wanted.size === 0) return steps;
  const start = steps.findIndex((s) => s.guide);
  if (start === -1) return steps;
  const guide = steps.slice(start);
  return [
    ...steps.slice(0, start),
    ...guide.filter((s) => wanted.has(s.id)),
    ...guide.filter((s) => !wanted.has(s.id)),
  ];
}

/** The setup steps, ordered by the user's answers.
 *
 *  The list never depends on the user's data. Connecting a bank can bring in
 *  investments, cards, loans and categorised transactions at once; those
 *  steps stay in the list, ticked and marked as already done, so the
 *  total does not shrink under the user mid-flow. */
export function visibleSteps(answers: StepAnswers = {}): OnboardingStep[] {
  return orderByAnswers(ONBOARDING_STEPS, answers);
}

/** The steps that have to be done for setup to count as finished. */
function owedSteps(steps: OnboardingStep[]): OnboardingStep[] {
  return steps.filter((s) => !s.optional);
}

/** Setup progress as both the wizard and the setup banner state it. Only owed
 *  steps are counted, so a plan without the optional budget step has the same
 *  total as one with it, and the two places never disagree. */
export function setupProgress(
  steps: OnboardingStep[],
  data: OnboardingData,
  completedSteps: string[],
): { done: number; total: number } {
  const owed = owedSteps(steps);
  return {
    done: owed.filter((s) => isStepDone(s, data, completedSteps)).length,
    total: owed.length,
  };
}

/** The step's place in the count ("Step 3 of 9"), or null for an optional
 *  step, which is not part of it. */
export function stepNumber(steps: OnboardingStep[], step: OnboardingStep): number | null {
  if (step.optional) return null;
  return owedSteps(steps).indexOf(step) + 1;
}

/** A follow-up the user's data already satisfies, most often because a
 *  linked bank brought the cards, holdings or categories in. */
export function doneByData(step: OnboardingStep, data: OnboardingData): boolean {
  return !!step.guide && step.isComplete(data);
}

/** A step counts as done when satisfied by data, or explicitly finished or
 *  skipped. A required step can only be satisfied by data. */
export function isStepDone(
  step: OnboardingStep,
  data: OnboardingData,
  completedSteps: string[],
): boolean {
  if (step.isComplete(data)) return true;
  return !step.required?.(data) && completedSteps.includes(step.id);
}

/** Index of the first required step that is not done, or -1. Every step after
 *  it is locked. */
export function firstBlockingStep(
  steps: OnboardingStep[],
  data: OnboardingData,
  completedSteps: string[],
): number {
  return steps.findIndex(
    (s) => s.required?.(data) && !isStepDone(s, data, completedSteps),
  );
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "profile",
    title: "About you",
    blurb: "Paiso uses your name to greet you and your date of birth to confirm you are an adult.",
    required: () => true,
    isComplete: (d) => d.hasProfile,
  },
  {
    id: "goals",
    title: "What brings you to Paiso?",
    blurb: "Pick everything you want to do. Paiso shows you those things first.",
    required: () => true,
    isComplete: (d) => d.hasGoals,
  },
  {
    id: "finances",
    title: "Tell us a little about your financial life",
    blurb: "Two quick questions. No account details, no balances. Your answers decide which setup steps come next.",
    required: () => true,
    isComplete: (d) => d.hasFinances,
  },
  {
    id: "institutions",
    title: "Add your accounts",
    blurb: "Bring in the accounts you use most. You can add the rest later.",
    isComplete: (d) => d.accountCount > 0,
  },
  {
    id: "snapshot",
    title: "Your snapshot",
    blurb: "Here is what Paiso found in the accounts you added.",
    // Finished only by the user saying the numbers look right.
    isComplete: () => false,
  },
  {
    id: "assets",
    guide: true,
    title: "Add your assets",
    blurb:
      "Track investments (stocks, ETFs, funds), real estate, and other valuables so your net worth stays complete.",
    route: "/investments/stocks",
    cta: "Add investments",
    ctaDrawer: "holding",
    extraLinks: [
      { label: "Add a property", route: "/investments/property" },
      { label: "Add other valuables", route: "/investments/other" },
    ],
    isComplete: (d) => d.hasAssets,
  },
  {
    id: "liabilities",
    guide: true,
    title: "Add your liabilities",
    blurb:
      "Add credit cards, loans, and mortgages so Paiso can net them against your assets and project payoff.",
    route: "/settings?add=1",
    cta: "Add a card or loan",
    isComplete: (d) => d.hasLiabilities,
  },
  {
    id: "categorize",
    guide: true,
    title: "Categorize your transactions",
    blurb:
      "Assign categories to your transactions so spending, cash flow, and budgets are accurate. Bulk-edit similar ones at once.",
    route: "/transactions/all",
    cta: "Go to Transactions",
    isComplete: (d) => d.hasCategorized,
  },
  {
    id: "budget",
    guide: true,
    optional: true,
    title: "Build your monthly budget",
    blurb:
      "Optional. Set monthly targets by category and track how each month performs against plan. You can do this anytime from Cash Flow → Budget.",
    route: "/cashflow/budget",
    cta: "Build budget",
    isComplete: (d) => d.budgetEnrolled,
  },
];
