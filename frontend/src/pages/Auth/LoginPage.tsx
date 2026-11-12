import { useState } from "react";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { Eye, EyeOff } from "@/lib/icons";
import { AuthShell } from "@/components/auth/AuthShell";
import { HostedPromo } from "@/components/auth/HostedPromo";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { usePageTitle } from "@/lib/pageTitle";
import { useAppInfo } from "@/hooks/useAppInfo";

export function LoginPage() {
  usePageTitle("section", "Sign in");
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: info } = useAppInfo();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post<{ access_token: string }>("/auth/login", {
        email,
        password,
        totp_code: totpCode || undefined,
      });
      setToken(res.access_token);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.detail?.toLowerCase().includes("2fa")) {
          // The first time, this is the server asking for the code. After
          // that it means the code that was typed is wrong, which used to
          // show nothing at all.
          if (needsTotp && totpCode.trim()) setError("That code is not right. Try again.");
          setNeedsTotp(true);
        } else {
          setError(err.detail);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  // Already signed in (in this tab or, through the stored hint, another):
  // go to the app. Without this a new tab opened on the sign-in address asked
  // for a password the browser already had a session for. If that session has
  // in fact ended, the first request is refused and the app returns here.
  if (isAuthenticated) return <Navigate to="/" replace />;
  // A fresh install has no account to sign in to, so it starts at sign-up.
  if (info?.signup_open) return <Navigate to="/register" replace />;

  return (
    <AuthShell backdrop="gradient">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to your account</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3">
              {error}
            </div>
          )}


          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1">
            {/* The reset link sits beside the box it is about. */}
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="password">Password</label>
              {!needsTotp && (
                <Link to="/forgot-password" className="text-xs text-primary hover:underline">
                  Forgot your password?
                </Link>
              )}
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full px-3 py-2 pr-10 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
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
          </div>

          {needsTotp && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="totp">Authenticator or recovery code</label>
              {/* No six-character limit and no digits-only keyboard: a
                  recovery code is fourteen characters with letters, and this
                  field is the only place to enter one. */}
              <input
                id="totp"
                type="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                required
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="000000"
              />
              <p className="text-xs text-muted-foreground">
                Enter the six-digit code from your authenticator app. If you cannot use the app, enter
                one of your recovery codes.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      <HostedPromo />
    </AuthShell>
  );
}
