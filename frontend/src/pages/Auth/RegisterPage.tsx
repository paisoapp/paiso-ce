import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Check, Circle, Eye, EyeOff } from "@/lib/icons";
import { useAuthStore } from "@/store/auth";
import { LegalNotice } from "@/components/auth/LegalNotice";
import { HostedPromo } from "@/components/auth/HostedPromo";
import { AuthShell, SignupSteps } from "@/components/auth/AuthShell";
import { usePageTitle } from "@/lib/pageTitle";
import { useAppInfo } from "@/hooks/useAppInfo";

const inputCls =
  "w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring";
const buttonCls =
  "w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors";

const MIN_PASSWORD = 8;

/** The rules the server checks in `password_problem` (backend/app/core/validation.py)
 *  that the browser can check too. "Too common" is left to the server. */
function passwordRules(password: string, email: string) {
  const folded = password.trim().toLowerCase();
  const local = email.split("@")[0].trim().toLowerCase();
  const isEmail = !!folded && (folded === email.trim().toLowerCase() || (local.length >= 4 && folded === local));
  return [
    { label: `At least ${MIN_PASSWORD} characters`, ok: password.length >= MIN_PASSWORD },
    { label: "Not your email address", ok: !!password && !isEmail },
  ];
}

/**
 * Sign-up in the self-hosted edition: email and password, then the setup
 * wizard. The edition sends no email, so `POST /auth/register` creates the
 * account at once and nothing confirms the address. Each install has one
 * account, so once it exists this page sends people to sign in.
 */
export function RegisterPage() {
  usePageTitle("section", "Create account");
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [loading, setLoading] = useState(false);
  const rules = passwordRules(password, email);
  const { data: info } = useAppInfo();
  const queryClient = useQueryClient();

  /** The browser takes "a@b" as an email address; the server will not. */
  function checkEmail(): boolean {
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    setEmailError(ok ? "" : "Enter a valid email address, like name@example.com.");
    return ok;
  }

  function checkPassword(): boolean {
    const broken = rules.find((r) => !r.ok);
    if (broken) setError(`Choose a password that meets every rule: ${broken.label.toLowerCase()}.`);
    return !broken;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!checkEmail() || !checkPassword()) return;
    setLoading(true);
    try {
      const res = await api.post<{ access_token: string }>("/auth/register", { email, password });
      setToken(res.access_token);
      // Sign-up is closed now; without this, signing out within five
      // minutes would bounce from /login back here.
      queryClient.invalidateQueries({ queryKey: ["app-info"] });
      navigate("/welcome", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.fields.email) setEmailError(err.fields.email);
      else setError(err instanceof ApiError ? err.detail : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (info && !info.signup_open) return <Navigate to="/login" replace />;

  return (
    <AuthShell>
      <div className="space-y-2">
        <SignupSteps current={0} />
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3">
            {error}
          </div>
        )}
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="email">Email</label>
          <input
            id="email" type="email" autoComplete="email" required value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(""); }}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "email-error" : undefined}
            className={cn(inputCls, emailError && "border-destructive")}
            placeholder="you@example.com"
          />
          {emailError && <p id="email-error" className="text-xs text-destructive">{emailError}</p>}
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="password">Password</label>
          <div className="relative">
            <input
              id="password" type={showPassword ? "text" : "password"} autoComplete="new-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              className={cn(inputCls, "pr-10")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2" aria-label="Password rules">
            {rules.map((r) => (
              <li key={r.label} className={cn("flex items-center gap-1.5", r.ok ? "text-primary" : "text-muted-foreground")}>
                {r.ok ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Circle className="h-3.5 w-3.5" aria-hidden />}
                {r.label}
              </li>
            ))}
          </ul>
        </div>
        <button type="submit" disabled={loading} className={buttonCls}>
          {loading ? "Working…" : "Create account"}
        </button>
      </form>
      <LegalNotice />
      <HostedPromo />
    </AuthShell>
  );
}
