import { useState } from "react";
import { ModeToggle } from "@/components/ui/ModeToggle";
import { Navigate, useNavigate } from "react-router-dom";
import { PaisoMark } from "@/components/brand/PaisoLogo";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { usePageTitle } from "@/lib/pageTitle";

/** Shown when an admin has flagged the account with must_change_password.
 *  The user knows their current password (otherwise they'd use the reset link). */
export function ForcePasswordChangePage() {
  usePageTitle("section", "Change password");
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setToken = useAuthStore((s) => s.setToken);
  const clearToken = useAuthStore((s) => s.clearToken);

  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ ok: boolean; access_token?: string }>("/auth/password", {
        current_password: current,
        new_password: password,
      });
      if (res.access_token) setToken(res.access_token);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.detail);
      else setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5 bg-background px-4">
      {/* Signed out there is no sidebar and no Settings, so this is the only
          place to change the look. It sits with the form rather than in the
          window corner, where it read as chrome. `order-last` puts it below
          the column without having to wrap it. [issue 210] */}
      <ModeToggle className="order-last" />
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2">
          {/* The logo carries the wordmark, so there is no text beside it. */}
          <PaisoMark className="h-20 w-20" />
          <p className="text-muted-foreground text-sm text-center">
            An administrator requires you to set a new password before continuing.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 bg-card border border-border rounded-lg p-6 shadow-sm">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="current-password">Current password</label>
            <input
              id="current-password" autoComplete="current-password"
              type="password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="new-password">New password</label>
            <input
              id="new-password" autoComplete="new-password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password" autoComplete="new-password"
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? "Saving…" : "Change password"}
          </button>
        </form>

        <button
          onClick={() => {
            clearToken();
            navigate("/login", { replace: true });
          }}
          className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out instead
        </button>
      </div>
    </div>
  );
}
