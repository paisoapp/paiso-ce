import { useState } from "react";
import { useOnboarding } from "@/components/onboarding/useOnboarding";
import { HAVE, MANAGE } from "../recommend";
import { OptionCard } from "./OptionCard";
import { StepActions, primaryBtn } from "./StepActions";

/**
 * How complicated the user's money is, without asking for any of it: how they
 * manage it today, and which kinds of account they have. Enough to recommend
 * a plan and order the setup guide. Account names and balances come later,
 * from the accounts themselves.
 */
export function FinancesStep({ onBack, onSaved }: { onBack?: () => void; onSaved: () => void }) {
  const { answers, setAnswers } = useOnboarding();
  const [manage, setManage] = useState<string | null>(answers?.manage ?? null);
  const [have, setHave] = useState<string[]>(answers?.have ?? []);
  // Continue stays enabled and says what is missing.
  const [tried, setTried] = useState(false);
  const missing = !manage
    ? "Choose how you manage your finances today."
    : have.length === 0
      ? "Pick at least one kind of account you have."
      : null;

  // Saved as they are picked, not only on Continue: going Back to change a
  // goal and returning used to wipe a half-answered screen.
  const pickManage = (id: string) => {
    setManage(id);
    setAnswers({ manage: id });
  };
  const toggle = (id: string) => {
    const next = have.includes(id) ? have.filter((x) => x !== id) : [...have, id];
    setHave(next);
    setAnswers({ have: next });
  };

  return (
    <>
      <div className="space-y-8 max-w-3xl">
        <fieldset>
          <legend className="text-sm font-medium mb-3">How do you manage your finances today?</legend>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {MANAGE.map((m) => (
              <OptionCard
                key={m.id} variant="chip" option={m}
                selected={manage === m.id} onClick={() => pickManage(m.id)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium mb-3">
            Which of these do you have?{" "}
            <span className="font-normal text-muted-foreground">Pick all that apply.</span>
          </legend>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {HAVE.map((h) => (
              <OptionCard
                key={h.id} variant="chip" option={h}
                selected={have.includes(h.id)} onClick={() => toggle(h.id)}
              />
            ))}
          </div>
        </fieldset>
      </div>
      {tried && missing && <p role="alert" className="mt-4 text-sm text-destructive">{missing}</p>}
      <StepActions onBack={onBack}>
        <button
          onClick={() => {
            setTried(true);
            if (missing) return;
            setAnswers({ manage, have });
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
