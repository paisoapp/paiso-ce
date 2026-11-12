import { useState } from "react";
import { useOnboarding } from "@/components/onboarding/useOnboarding";
import { GOALS } from "../recommend";
import { OptionCard } from "./OptionCard";
import { StepActions, primaryBtn } from "./StepActions";

/** What the user came to do. Multi-select cards. */
export function GoalsStep({ onBack, onSaved }: { onBack?: () => void; onSaved: () => void }) {
  const { answers, setAnswers } = useOnboarding();
  const [goals, setGoals] = useState<string[]>(answers?.goals ?? []);
  // Continue stays enabled and says what is missing.
  const [tried, setTried] = useState(false);

  // Saved as they are picked, so nothing is lost by stepping away.
  const toggle = (id: string) => {
    const next = goals.includes(id) ? goals.filter((x) => x !== id) : [...goals, id];
    setGoals(next);
    setAnswers({ goals: next });
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 max-w-3xl">
        {GOALS.map((g) => (
          <OptionCard key={g.id} option={g} selected={goals.includes(g.id)} onClick={() => toggle(g.id)} />
        ))}
      </div>
      {tried && goals.length === 0 && (
        <p role="alert" className="mt-4 text-sm text-destructive">Pick at least one to continue.</p>
      )}
      <StepActions onBack={onBack}>
        <button
          onClick={() => {
            setTried(true);
            if (goals.length === 0) return;
            setAnswers({ goals });
            onSaved();
          }}
          className={primaryBtn}
        >
          Continue
        </button>
      </StepActions>
    </>
  );
}
