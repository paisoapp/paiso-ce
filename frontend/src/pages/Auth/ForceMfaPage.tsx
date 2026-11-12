import { useEffect, useRef, useState } from "react";
import { ModeToggle } from "@/components/ui/ModeToggle";
import { Navigate, useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { PaisoMark } from "@/components/brand/PaisoLogo";
import { RecoveryCodesDialog } from "@/components/auth/RecoveryCodesDialog";
import { api, ApiError } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { usePageTitle } from "@/lib/pageTitle";

/** Shown when an admin has flagged the account with mfa_required and the user
 *  hasn't enrolled in TOTP yet. Reuses the /auth/totp enroll+verify endpoints. */
export function ForceMfaPage() {
  usePageTitle("section", "Set up two-factor authentication");
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const clearToken = useAuthStore((s) => s.clearToken);

  const [provisioningUri, setProvisioningUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (provisioningUri && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, provisioningUri, { width: 200, margin: 2 });
    }
  }, [provisioningUri]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  async function startEnroll() {
    setError("");
    setLoading(true);
    try {
      const res = await api.post<{ provisioning_uri: string }>("/auth/totp/enroll", {});
      setProvisioningUri(res.provisioning_uri);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post<{ backup_codes?: string[] }>("/auth/totp/verify", { code });
      // The codes are shown once, here. Leaving for the app waits until the
      // person has saved them.
      if (res.backup_codes?.length) setRecoveryCodes(res.backup_codes);
      else navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Something went wrong");
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
      {recoveryCodes && (
        <RecoveryCodesDialog codes={recoveryCodes} onClose={() => navigate("/", { replace: true })} />
      )}
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2">
          {/* The logo carries the wordmark, so there is no text beside it. */}
          <PaisoMark className="h-20 w-20" />
          <p className="text-muted-foreground text-sm text-center">
            An administrator requires two-factor authentication on your account.
          </p>
        </div>

        <div className="space-y-4 bg-card border border-border rounded-lg p-6 shadow-sm">
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3">
              {error}
            </div>
          )}

          {!provisioningUri ? (
            <>
              <p className="text-sm text-muted-foreground">
                You scan a QR code with an authenticator app (Google Authenticator, 1Password,
                Authy, …) and enter the 6-digit code it shows.
              </p>
              <button
                onClick={startEnroll}
                disabled={loading}
                className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? "Preparing…" : "Set up authenticator"}
              </button>
            </>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              <div className="flex justify-center">
                <canvas ref={canvasRef} className="rounded-md border border-border" />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="totp-code">6-digit code</label>
                <input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="000000"
                />
              </div>
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {loading ? "Verifying…" : "Verify & continue"}
              </button>
            </form>
          )}
        </div>

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
