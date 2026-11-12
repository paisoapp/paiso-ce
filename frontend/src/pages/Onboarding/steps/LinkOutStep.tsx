import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle } from "@/lib/icons";
import type { OnboardingData, OnboardingStep, StepLink } from "@/components/onboarding/steps";

// The Stocks & Funds page is a large chunk; load its drawer only when opened.
const AddHoldingDrawer = lazy(() =>
  import("@/pages/Investments/StocksPage").then((m) => ({ default: m.AddHoldingDrawer })),
);

/** The links a step leads with, adjusted to what the user already has. With a
 *  mortgage and no home, "Add investments" was the wrong first suggestion:
 * the home is what is missing from their net worth. */
function linksFor(step: OnboardingStep, data?: OnboardingData): { lead: StepLink | null; extra: StepLink[] } {
  const lead = step.route && step.cta ? { label: step.cta, route: step.route } : null;
  const extra = step.extraLinks ?? [];
  if (step.id === "assets" && data?.mortgageWithoutHome) {
    const home = { label: "Add the home your mortgage is for", route: "/investments/property?add=mortgage" };
    return {
      lead: home,
      extra: [...(lead ? [lead] : []), ...extra.filter((l) => !l.route.startsWith("/investments/property"))],
    };
  }
  return { lead, extra };
}

/** Generic step body: explainer + deep link into the relevant page. */
export function LinkOutStep({ step, data, note }: {
  step: OnboardingStep;
  data?: OnboardingData;
  /** Said above the links, for example that the step is partly done. */
  note?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { lead, extra } = linksFor(step, data);
  // The lead action opens a drawer here when the step has one, so adding an
  // investment does not leave the wizard. A lead the step swapped for another
  // link (the home a mortgage is for) still navigates.
  const drawer = lead && lead.route === step.route ? step.ctaDrawer : undefined;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  return (
    <div className="space-y-3 max-w-md">
      {note}
      {added.length > 0 && (
        <p className="flex items-center gap-2 text-sm text-success">
          <CheckCircle className="h-4 w-4 shrink-0" />
          Added {added.join(", ")}.
        </p>
      )}
      {lead && (
        <button
          onClick={() => (drawer ? setDrawerOpen(true) : navigate(lead.route))}
          className="px-4 py-2 text-sm font-medium border border-primary text-primary rounded-md hover:bg-primary/10"
        >
          {drawer && added.length > 0 ? "Add another investment" : lead.label}
        </button>
      )}
      {extra.map((l) => (
        <button
          key={l.route}
          onClick={() => navigate(l.route)}
          className="block text-sm text-primary hover:underline"
        >
          {l.label}
        </button>
      ))}
      {(extra.length > 0 || !drawer) && (
        <p className="text-xs text-muted-foreground">
          {drawer ? "These links leave the wizard." : "You will leave the wizard."} The setup banner keeps
          track and brings you back.
        </p>
      )}
      {drawer === "holding" && (
        <Suspense fallback={null}>
          <AddHoldingDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            onCreated={(h) => setAdded((a) => [...a, h.ticker ?? h.name ?? "a holding"])}
          />
        </Suspense>
      )}
    </div>
  );
}
