import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { LogOut, Shield, ShieldCheck, ShieldOff } from "@/lib/icons";
import { useAuthStore } from "@/store/auth";
import { useMe } from "@/hooks/useMe";
import { RecoveryCodesDialog } from "@/components/auth/RecoveryCodesDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDate, formatDateTime } from "@/lib/dates";

/**
 * Everything that decides who can get into the account: how you sign in, the
 * password, the second factor, and which devices are signed in.
 */
export function SecurityTab() {
  return (
    <div className="space-y-8 max-w-sm">
      <h2 className="text-xl font-semibold">Security</h2>

      <PasswordCard />
      <hr className="border-border" />

      <TwoFactorCard />

      <hr className="border-border" />

      <SessionsCard />
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const changePassword = useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) =>
      api.post<{ ok: boolean; access_token?: string }>("/auth/password", body),
    onSuccess: (res) => {
      // The server signs every other device out and hands back a fresh
      // access token so this session keeps working.
      if (res.access_token) useAuthStore.getState().replaceToken(res.access_token);
      setMsg({ text: "Password changed. Paiso signed out your other devices.", ok: true });
      setCurrent(""); setNext(""); setConfirmPwd("");
    },
    onError: (e: Error) => setMsg({ text: e.message, ok: false }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirmPwd) { setMsg({ text: "The new passwords do not match.", ok: false }); return; }
    changePassword.mutate({ current_password: current, new_password: next });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-base font-medium">Change password</h3>
      <Input id="current-password" label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      <Input id="new-password" label="New password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
      <Input id="confirm-password" label="Confirm new password" type="password" autoComplete="new-password" required value={confirmPwd} onChange={(e) => setConfirmPwd(e.target.value)} />
      {msg && <p className={cn("text-sm", msg.ok ? "text-success" : "text-destructive")}>{msg.text}</p>}
      <Button type="submit" loading={changePassword.isPending}>Update password</Button>
    </form>
  );
}

/** What a 2FA change asks for again: the password when the account has one,
 *  and a code from the authenticator app or a recovery code. A session alone
 *  is not enough, so a stolen one cannot strip the second factor. */
function ReauthDialog({
  title, intro, confirmLabel, destructive, pending, error, onSubmit, onClose,
}: {
  title: string;
  intro: string;
  confirmLabel: string;
  destructive?: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (body: { password?: string; code: string }) => void;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const needsPassword = me?.has_password !== false;

  return (
    <Dialog open onClose={onClose} className="md:max-w-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ password: needsPassword ? password : undefined, code: code.trim() });
        }}
      >
        <DialogHeader onClose={onClose}>{title}</DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">{intro}</p>
          {needsPassword && (
            <Input id="reauth-password" label="Password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
          <Input
            id="reauth-code"
            label="Authenticator or recovery code"
            autoComplete="one-time-code"
            required
            autoFocus={!needsPassword}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={destructive ? "destructive" : undefined} loading={pending} disabled={!code.trim()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function TwoFactorCard() {
  const qc = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [step, setStep] = useState<"idle" | "verifying">("idle");
  const [provisioningUri, setProvisioningUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [asking, setAsking] = useState<"disable" | "regenerate" | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const { data: me, refetch: refetchMe } = useMe();
  const totpEnabled = me?.totp_enabled ?? false;

  const { data: codeStatus } = useQuery({
    queryKey: ["auth-backup-codes"],
    queryFn: () => api.get<{ total: number; remaining: number }>("/auth/totp/backup-codes"),
    enabled: totpEnabled,
  });

  // Draw the QR once the canvas mounts (step changes to "verifying").
  useEffect(() => {
    if (step === "verifying" && provisioningUri && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, provisioningUri, { width: 200, margin: 2 });
    }
  }, [step, provisioningUri]);

  const enroll = useMutation({
    mutationFn: () => api.post<{ provisioning_uri: string }>("/auth/totp/enroll", {}),
    onSuccess: (data) => {
      setProvisioningUri(data.provisioning_uri);
      setStep("verifying");
      setCode("");
      setMsg(null);
    },
    onError: (e: Error) => setMsg({ text: e.message, ok: false }),
  });

  const verify = useMutation({
    mutationFn: (c: string) => api.post<{ backup_codes?: string[] }>("/auth/totp/verify", { code: c }),
    onSuccess: (res) => {
      setStep("idle");
      setProvisioningUri(null);
      setMsg({ text: "Two-factor authentication is on.", ok: true });
      if (res.backup_codes?.length) setNewCodes(res.backup_codes);
      refetchMe();
      qc.invalidateQueries({ queryKey: ["auth-backup-codes"] });
    },
    onError: () => setMsg({ text: "That code is not right. Try again.", ok: false }),
  });

  const reauth = useMutation({
    mutationFn: (body: { password?: string; code: string }) =>
      asking === "disable"
        ? api.post<{ backup_codes?: string[] }>("/auth/totp/disable", body)
        : api.post<{ backup_codes?: string[] }>("/auth/totp/backup-codes", body),
    onSuccess: (res) => {
      if (asking === "disable") {
        setMsg({ text: "Two-factor authentication is off. Paiso emailed you a confirmation.", ok: true });
        refetchMe();
      } else if (res.backup_codes?.length) {
        setNewCodes(res.backup_codes);
      }
      qc.invalidateQueries({ queryKey: ["auth-backup-codes"] });
      setAsking(null);
    },
    onError: (e: Error) => setAskError(e instanceof ApiError ? e.detail : e.message),
  });

  function ask(what: "disable" | "regenerate") {
    setAskError(null);
    reauth.reset();
    setAsking(what);
  }

  return (
    <div className="space-y-4">
      <h3 className="text-base font-medium">Two-factor authentication</h3>

      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-3">
          {totpEnabled
            ? <ShieldCheck size={22} className="text-success shrink-0" />
            : <ShieldOff size={22} className="text-muted-foreground shrink-0" />}
          <div>
            <p className="font-medium text-sm">Authenticator app</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {totpEnabled
                ? "Paiso asks for a six-digit code from your app when you sign in."
                : "Use any authenticator app that supports TOTP codes."}
            </p>
          </div>
        </div>

        <div className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          totpEnabled ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
        )}>
          <span className={cn("h-1.5 w-1.5 rounded-full", totpEnabled ? "bg-success" : "bg-muted-foreground")} />
          {totpEnabled ? "On" : "Off"}
        </div>

        {step === "verifying" && (
          <div className="space-y-3 pt-1">
            <p className="text-xs text-muted-foreground">
              Scan this QR code with your authenticator app, then enter the six-digit code it shows.
            </p>
            <div className="flex justify-center">
              <canvas ref={canvasRef} className="rounded-lg border border-border" />
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); if (code.length === 6) verify.mutate(code); }}
              className="flex gap-2"
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder="000000"
                aria-label="Six-digit code"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-center tracking-widest font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                autoFocus
              />
              <Button type="submit" loading={verify.isPending} disabled={code.length !== 6}>
                Verify
              </Button>
            </form>
            <button
              type="button"
              onClick={() => { setStep("idle"); setProvisioningUri(null); setMsg(null); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {msg && <p className={cn("text-sm", msg.ok ? "text-success" : "text-destructive")}>{msg.text}</p>}

        {!totpEnabled && step === "idle" && (
          <Button onClick={() => enroll.mutate()} loading={enroll.isPending} className="w-full">
            <Shield size={14} />
            Turn on two-factor authentication
          </Button>
        )}

        {totpEnabled && (
          <>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Recovery codes</p>
                <p className="text-xs text-muted-foreground">
                  {codeStatus
                    ? `${codeStatus.remaining} of ${codeStatus.total} unused. Each one signs you in once without the app.`
                    : "Each one signs you in once without the app."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => ask("regenerate")}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              >
                New codes
              </button>
            </div>
            <button
              type="button"
              onClick={() => ask("disable")}
              className="flex items-center justify-center gap-2 w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
            >
              <ShieldOff size={14} />
              Turn off two-factor authentication
            </button>
          </>
        )}
      </div>

      {asking && (
        <ReauthDialog
          title={asking === "disable" ? "Turn off two-factor authentication" : "Get new recovery codes"}
          intro={
            asking === "disable"
              ? "Your password alone will protect the account, and your recovery codes will stop working. Confirm it is you."
              : "Your current recovery codes will stop working. Confirm it is you."
          }
          confirmLabel={asking === "disable" ? "Turn off" : "Get new codes"}
          destructive={asking === "disable"}
          pending={reauth.isPending}
          error={askError}
          onSubmit={(body) => { setAskError(null); reauth.mutate(body); }}
          onClose={() => setAsking(null)}
        />
      )}

      {newCodes && <RecoveryCodesDialog codes={newCodes} onClose={() => setNewCodes(null)} />}
    </div>
  );
}

interface DeviceSession {
  id: number;
  signed_in_at: string;
  last_active_at: string;
  current: boolean;
  /** "Chrome on macOS", from the browser's User-Agent at sign-in; null for
   *  sessions from before it was kept. */
  device?: string | null;
}

/** How many devices show before "Show all". */
const SESSIONS_SHOWN = 5;

function SessionsCard() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const { data } = useQuery({
    queryKey: ["auth-sessions"],
    queryFn: () => api.get<{ active: number; sessions?: DeviceSession[] }>("/auth/sessions"),
  });
  const [showAll, setShowAll] = useState(false);
  const others = Math.max((data?.active ?? 1) - 1, 0);
  const sessions = data?.sessions ?? [];
  const shown = showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN);

  const revoke = useMutation({
    mutationFn: () => api.post<{ access_token: string }>("/auth/sessions/revoke-others", {}),
    onSuccess: (res) => {
      // Every session is replaced, this one included, so take the new token.
      useAuthStore.getState().replaceToken(res.access_token);
      setMsg({ text: "Paiso signed out your other devices.", ok: true });
      qc.invalidateQueries({ queryKey: ["auth-sessions"] });
    },
    onError: (e: Error) => setMsg({ text: e.message, ok: false }),
  });

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium">Devices</h3>
      <p className="text-sm text-muted-foreground">
        {data === undefined
          ? "Sign out everywhere except this device."
          : others === 0
            ? "This is the only device signed in to your account."
            : `Your account is signed in on ${others} other ${others === 1 ? "device" : "devices"}.`}
      </p>
      {/* Each signed-in device, so the count above can be checked,
          named by the browser it signed in from. This device and the
          most recently used come first; the rest wait behind "Show all". */}
      {shown.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {shown.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {s.current ? "This device" : (s.device ?? "Another device")}
                  {s.current && s.device && (
                    <span className="font-normal text-muted-foreground"> · {s.device}</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Signed in {formatDate(s.signed_in_at)} · last active {formatDateTime(s.last_active_at)}
                </p>
              </div>
              {s.current && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  Current
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessions.length > SESSIONS_SHOWN && (
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show fewer" : `Show all ${sessions.length} devices`}
        </button>
      )}
      {msg && <p className={cn("text-sm", msg.ok ? "text-success" : "text-destructive")}>{msg.text}</p>}
      <Button variant="outline" onClick={() => revoke.mutate()} loading={revoke.isPending} disabled={data !== undefined && others === 0}>
        <LogOut size={14} />
        Sign out all other devices
      </Button>
    </div>
  );
}
