import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router-dom";
import { CheckCircle } from "@/lib/icons";
import { PaisoMark, Wordmark } from "@/components/brand/PaisoLogo";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { useMe } from "@/hooks/useMe";
import { useHydrateUiPrefs } from "@/hooks/useUiPrefs";
import {
  doneByData,
  firstBlockingStep,
  isStepDone,
  setupProgress,
  stepNumber,
  visibleSteps,
  type OnboardingData,
} from "@/components/onboarding/steps";
import { useOnboarding } from "@/components/onboarding/useOnboarding";
import {
  useAccountOnlyData,
  useOnboardingData,
} from "@/components/onboarding/OnboardingController";
import { DataStep } from "./steps/DataStep";
import { FinancesStep } from "./steps/FinancesStep";
import { GoalsStep } from "./steps/GoalsStep";
import { LinkOutStep } from "./steps/LinkOutStep";
import { ProfileStep } from "./steps/ProfileStep";
import { SnapshotStep } from "./steps/SnapshotStep";
import { StepActions, primaryBtn } from "./steps/StepActions";
import { usePageTitle } from "@/lib/pageTitle";

function Frame({ header, children }: { header?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between px-4 sm:px-6 h-14 border-b border-border">
        <div className="flex items-center gap-2">
          <PaisoMark className="h-9 w-9" />
          <Wordmark />
          <span className="text-sm text-muted-foreground ml-2 hidden sm:inline">Set up your account</span>
        </div>
        {header}
      </header>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <Frame>
      <div className="flex justify-center py-24">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    </Frame>
  );
}

type Signals = { data: OnboardingData; loading: boolean };

/** Reads the signals that come from the user's financial data and hands them
 *  up to the wizard shell. */
function DataProbe({ onChange }: { onChange: (s: Signals) => void }) {
  const signals = useOnboardingData();
  const key = JSON.stringify(signals);
  useEffect(() => {
    onChange(signals);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function WizardShell() {
  const navigate = useNavigate();
  const clearToken = useAuthStore((s) => s.clearToken);
  const account = useAccountOnlyData();
  const [full, setFull] = useState<Signals | null>(null);
  const data = full ? full.data : account.data;
  const loading = account.loading || !full || full.loading;
  const {
    status, completedSteps, currentStep, answers,
    start, setStep, markStepDone, dismiss, complete,
  } = useOnboarding();

  // The list depends only on the plan and the answers, never on what the
  // user's data covers, so it holds still while an import lands.
  const steps = useMemo(
    () => visibleSteps(answers),
    [answers],
  );

  // Entering the wizard puts the flow into "active" (e.g. straight after signup).
  useEffect(() => {
    if (status !== "active") start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = (i: number) => isStepDone(steps[i], data, completedSteps);

  // Where to open: the first thing left to do, not a remembered index. The
  // index is only a position within one visit; what the user has actually
  // done is the durable fact, and it survives a new browser or a cleared
  // cache where the index would not.
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (loading || resumed) return;
    setResumed(true);
    const firstOpen = steps.findIndex((_, i) => !done(i));
    if (firstOpen !== -1 && firstOpen !== currentStep) setStep(firstOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // A new step opens at its top, not wherever the last one was scrolled
  // to.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [currentStep]);

  const probe = <DataProbe onChange={setFull} />;

  // Nothing is drawn until the first answers are in. Drawing first and
  // correcting after is what made the wizard flash a wrong step or a wrong
  // button. Later reloads (an account being added)
  // update the screen in place.
  if (!resumed) {
    return (
      <>
        {probe}
        <Loading />
      </>
    );
  }

  // A required step that is not done locks everything after it.
  const blocking = firstBlockingStep(steps, data, completedSteps);
  const lastReachable = blocking === -1 ? steps.length - 1 : blocking;
  const idx = Math.min(Math.max(currentStep, 0), Math.max(lastReachable, 0));
  const step = steps[idx];
  // Finished means everything owed is done. An optional step never holds
  // the wizard open.
  const allDone = steps.every((s, i) => s.optional || done(i));
  const isLast = idx === steps.length - 1;
  const total = setupProgress(steps, data, completedSteps).total;
  const number = step ? stepNumber(steps, step) : null;

  function finish() {
    complete();
    navigate("/", { replace: true });
  }

  function skipAll() {
    dismiss();
    navigate("/", { replace: true });
  }

  /** Forward to the next step that still needs doing, or out. */
  function next() {
    const after = steps.findIndex((s, i) => i > idx && !done(i) && !s.optional);
    if (after !== -1) setStep(after);
    else finish();
  }

  const back = idx > 0 ? () => setStep(idx - 1) : undefined;
  const skip =
    step && !step.required?.(data) && !step.optional && !done(idx)
      ? () => {
          markStepDone(step.id);
          next();
        }
      : undefined;

  return (
    <>
    {probe}
    <Frame
      header={
        blocking === -1 ? (
          <button onClick={skipAll} className="text-sm text-muted-foreground hover:text-foreground">
            Skip the rest and explore
          </button>
        ) : (
          // Nothing to skip to while a required step is open: the app is
          // closed until it is done. Leaving is the only other way out.
          <button
            onClick={() => {
              clearToken();
              navigate("/login", { replace: true });
            }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        )
      }
    >
      <div
        className={cn(
          "mx-auto px-4 py-6 sm:py-8 grid gap-6 md:gap-8 md:grid-cols-[240px_1fr]",
          "max-w-5xl",
        )}
      >
        {/* Step rail */}
        <nav className="space-y-1">
          {steps.map((s, i) => {
            const locked = i > lastReachable;
            return (
              <button
                key={s.id}
                disabled={locked}
                title={locked ? "Finish the steps above first" : undefined}
                onClick={() => setStep(i)}
                className={cn(
                  "w-full flex items-start gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  i === idx ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted",
                  locked && "opacity-40 hover:bg-transparent cursor-not-allowed",
                  // On a phone the rail would push the step off screen: show
                  // only where the user is.
                  i !== idx && "hidden md:flex",
                )}
              >
                <span
                  className={cn(
                    "mt-px flex h-5 w-5 items-center justify-center rounded-full border text-[10px] shrink-0",
                    done(i)
                      ? "bg-success border-success text-success-foreground"
                      : i === idx
                        ? "border-primary text-primary"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {done(i) ? <CheckCircle className="h-3 w-3" /> : (stepNumber(steps, s) ?? "–")}
                </span>
                {/* Wraps rather than truncating: "What brings you to Pa…"
                    hid most of the step's name. */}
                <span className="min-w-0 leading-snug">{s.title}</span>
                {s.optional && (
                  <span className="ml-auto mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Optional
                  </span>
                )}
              </button>
            );
          })}
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            {number ? `Step ${number} of ${total}` : "Optional step"}
          </p>
        </nav>

        {/* Step content. Keyed by step so one step's fields and focus never
            carry into the next. */}
        <section className="min-w-0" key={step?.id}>
          {step && (
            <>
              <h1 className="text-xl font-semibold">{step.title}</h1>
              <p className="text-sm text-muted-foreground mt-1 mb-6 max-w-xl">{step.blurb}</p>

              {/* Each step shows exactly one way forward. These four bring
                  their own, because going forward is what saves them. */}
              {step.id === "profile" ? (
                <ProfileStep onSaved={next} />
              ) : step.id === "goals" ? (
                <GoalsStep onBack={back} onSaved={next} />
              ) : step.id === "finances" ? (
                <FinancesStep onBack={back} onSaved={next} />
              ) : step.id === "snapshot" && data.accountCount > 0 ? (
                <SnapshotStep
                  onBack={back}
                  // The follow-ups after the snapshot are reachable from the
                  // step itself, not only from the rail.
                  onNext={
                    steps.some((s, i) => i > idx && !done(i) && !s.optional)
                      ? () => { markStepDone("snapshot"); next(); }
                      : undefined
                  }
                  onContinue={(to) => {
                    // The wizard's job is done here. Anything still owed is a
                    // to-do list, and the setup banner carries it.
                    markStepDone("snapshot");
                    navigate(to === "dashboard" ? "/?customize=1" : "/portfolio", {
                      replace: true,
                    });
                  }}
                />
              ) : (
                <>
                  {step.id === "institutions" ? (
                    <DataStep />
                  ) : step.id === "snapshot" ? (
                    <p className="text-sm text-muted-foreground max-w-md">
                      There is nothing to add up yet. Go back and add an account, or skip
                      this for now and return to it later.
                    </p>
                  ) : doneByData(step, data) && !(step.id === "assets" && data.mortgageWithoutHome) ? (
                    <p className="text-sm max-w-md">
                      <span className="font-medium">Already done.</span>{" "}
                      <span className="text-muted-foreground">
                        Your accounts already include this. You can add more later.
                      </span>
                    </p>
                  ) : (
                    <LinkOutStep
                      step={step}
                      data={data}
                      note={
                        step.id === "assets" && data.mortgageWithoutHome ? (
                          <p className="text-sm text-muted-foreground">
                            You added a mortgage but not the home it pays for. Add the home so
                            its value counts in your net worth alongside the loan.
                          </p>
                        ) : undefined
                      }
                    />
                  )}
                  <StepActions onBack={back} onSkip={skip}>
                    {/* An optional step can always be left by finishing. */}
                    {(done(idx) || step.optional) && (
                      <button onClick={allDone || isLast ? finish : next} className={primaryBtn}>
                        {allDone || isLast ? "Finish and open my dashboard" : "Continue"}
                      </button>
                    )}
                  </StepActions>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </Frame>
    </>
  );
}

export function WizardPage() {
  usePageTitle("section", "Set up Paiso");
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: me } = useMe();
  // The wizard saves its progress on every step. It has to load the saved
  // copy before it writes one, or signing in on a new browser overwrites the
  // user's answers with a blank slate.
  const { ready } = useHydrateUiPrefs();
  const hydrated = useUiPrefsStore((s) => s.hydratedForSession);
  // If the saved copy cannot be fetched there is nothing to wait for: carry
  // on with what this browser has rather than spin forever.
  const fetchFailed =
    useQueryClient().getQueryState(["settings-profile"])?.status === "error";

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!me || !ready || (!hydrated && !fetchFailed)) return <Loading />;
  return <WizardShell />;
}
