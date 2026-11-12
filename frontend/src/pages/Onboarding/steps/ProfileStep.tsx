import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useMe } from "@/hooks/useMe";
import { MIN_ACCOUNT_HOLDER_AGE, dobBounds, dobError } from "@/lib/validation";
import { StepActions, primaryBtn } from "./StepActions";

const inputCls =
  "w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring";

/** Name and date of birth, saved via PATCH /auth/me. Phone is not asked here;
 *  it lives in Settings for the features that need it. */
export function ProfileStep({ onSaved }: { onSaved: () => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [dob, setDob] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Errors show once Continue is pressed: the button never disables
  // silently, it says what is missing instead.
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (me) {
      setFirst((v) => v || me.first_name || "");
      setLast((v) => v || me.last_name || "");
      setDob((v) => v || me.dob || "");
    }
  }, [me]);

  // Accuracy, not just format: a real, adult date of birth, checked
  // here and again by the API.
  const dobProblem = dobError(dob, { minAge: MIN_ACCOUNT_HOLDER_AGE });
  const dobLimits = dobBounds(MIN_ACCOUNT_HOLDER_AGE);
  // Last name is optional: some people have a single name.
  const firstProblem = first.trim() ? null : "Enter your first name.";
  const dobMissing = dob ? null : "Enter your date of birth.";
  const canSave = !firstProblem && !dobMissing && !dobProblem;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await api.patch("/auth/me", { first_name: first, last_name: last, dob });
      await qc.invalidateQueries({ queryKey: ["auth-me"] });
      onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 422
          ? err.detail
          : "Could not save your profile. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} noValidate>
      <div className="space-y-3 max-w-md">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="paiso-first">First name</label>
          <input id="paiso-first" value={first} autoComplete="given-name"
                 aria-invalid={tried && firstProblem ? true : undefined}
                 onChange={(e) => setFirst(e.target.value)}
                 className={cn(inputCls, tried && firstProblem && "border-destructive")} />
          {tried && firstProblem && <p className="text-xs text-destructive">{firstProblem}</p>}
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="paiso-last">
            Last name <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input id="paiso-last" value={last} autoComplete="family-name"
                 onChange={(e) => setLast(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="paiso-dob">Date of birth</label>
        <input id="paiso-dob" type="date" value={dob} autoComplete="bday"
               min={dobLimits.min} max={dobLimits.max}
               aria-invalid={dobProblem || (tried && dobMissing) ? true : undefined}
               onChange={(e) => setDob(e.target.value)}
               className={cn(inputCls, (dobProblem || (tried && dobMissing)) && "border-destructive")} />
        {(dobProblem || (tried && dobMissing)) && (
          <p className="text-xs text-destructive">{dobProblem || dobMissing}</p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <StepActions>
        <button type="submit" disabled={saving} className={primaryBtn}>
          {saving ? "Saving…" : "Continue"}
        </button>
      </StepActions>
    </form>
  );
}
