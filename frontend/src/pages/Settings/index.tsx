import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Camera, Info, LogOut, Mail, Trash2 } from "@/lib/icons";
import { useAuthStore } from "@/store/auth";
import { avatarInitial, useMe } from "@/hooks/useMe";

import { downscaleImage } from "@/lib/image";
import { useDisplayModeStore, type DisplayMode } from "@/store/displayMode";
import { useTheme, type Mode } from "@/hooks/useTheme";
import { enabledThemes } from "@/lib/themes";
import { usePageTitle } from "@/lib/pageTitle";
import { PillTabStrip } from "@/components/ui/PillTabStrip";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { NAV_ITEMS } from "@/lib/navRoutes";
import { Sun, Moon, Monitor, Contrast } from "@/lib/icons";
import { AccountList } from "@/components/accounts/AccountList";
import { AboutTab } from "./AboutTab";
import { SecurityTab } from "./SecurityTab";
import { CategoriesTab } from "./CategoriesTab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { MIN_ACCOUNT_HOLDER_AGE, dobBounds, dobError } from "@/lib/validation";
import { PhoneInput, formatPhoneForDisplay, phoneError } from "@/components/ui/PhoneInput";

type Tab = "accounts" | "categories" | "account" | "security" | "about";

const TABS: { id: Tab; label: string }[] = [
  // Tab id stays "accounts" — ?tab= deep links and the sidebar rely on it.
  { id: "accounts", label: "Accounts" },
  { id: "categories", label: "Categories" },
  { id: "account", label: "My Account" },
  { id: "security", label: "Security" },
  { id: "about", label: "About" },
];

export function SettingsPage() {
  // The active tab is driven by the `?tab=` query param so other parts of the
  // app (e.g. the sidebar user link) can deep-link straight to "My Account".
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tabs = TABS;
  const tab: Tab = tabs.find((t) => t.id === tabParam)?.id ?? "accounts";
  const setTab = (id: Tab) =>
    setSearchParams(id === "accounts" ? {} : { tab: id }, { replace: true });
  usePageTitle("tab", tabs.find((t) => t.id === tab)?.label);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your accounts and preferences.</p>
      </div>

      {/* Mobile: the same row of pills as the section tabs on Investments,
          Budgeting and Transactions. It had been a dropdown. */}
      <PillTabStrip
        label="Settings section"
        items={tabs.map((t) => ({ key: t.id, label: t.label, onSelect: () => setTab(t.id) }))}
        activeKey={tab}
      />

      {/* Desktop: tab bar */}
      <div className="hidden md:flex gap-1 border-b border-border overflow-x-auto overflow-y-hidden">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0",
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "accounts" && <AccountList />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "account" && <AccountTab />}
      {tab === "security" && <SecurityTab />}
      {tab === "about" && <AboutTab />}
    </div>
  );
}


function ProfileCard() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const fileRef = useRef<HTMLInputElement>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [avatarMsg, setAvatarMsg] = useState("");

  // Seed the form once `me` loads (and whenever it changes server-side).
  useEffect(() => {
    setFirstName(me?.first_name ?? "");
    setLastName(me?.last_name ?? "");
    setDob(me?.dob ?? "");
    setPhone(formatPhoneForDisplay(me?.phone));
  }, [me?.first_name, me?.last_name, me?.dob, me?.phone]);

  const dirty =
    firstName !== (me?.first_name ?? "") ||
    lastName !== (me?.last_name ?? "") ||
    dob !== (me?.dob ?? "") ||
    // The API stores E.164; the field shows "(415) 555-0123".
    phone !== formatPhoneForDisplay(me?.phone);
  // Accuracy, not just format — the API enforces the same rules.
  const dobProblem = dobError(dob, { minAge: MIN_ACCOUNT_HOLDER_AGE });
  const phoneProblem = phoneError(phone);
  const dobLimits = dobBounds(MIN_ACCOUNT_HOLDER_AGE);

  const saveProfile = useMutation({
    mutationFn: () =>
      api.patch("/auth/me", {
        first_name: firstName,
        last_name: lastName,
        dob: dob || null,
        phone,
      }),
    onSuccess: () => {
      setSavedMsg("Saved.");
      // Refresh My Account and the sidebar.
      qc.invalidateQueries({ queryKey: ["auth-me"] });
    },
    onError: (e: Error) => setSavedMsg(e.message),
  });

  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      const blob = await downscaleImage(file);
      const fd = new FormData();
      fd.append("file", blob, "avatar.jpg");
      return api.upload("/auth/me/avatar", fd);
    },
    onSuccess: () => {
      setAvatarMsg("");
      qc.invalidateQueries({ queryKey: ["auth-me"] });
    },
    onError: (e: Error) => setAvatarMsg(e.message),
  });

  const removeAvatar = useMutation({
    mutationFn: () => api.delete("/auth/me/avatar"),
    onSuccess: () => {
      setAvatarMsg("");
      qc.invalidateQueries({ queryKey: ["auth-me"] });
    },
    onError: (e: Error) => setAvatarMsg(e.message),
  });

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (file) uploadAvatar.mutate(file);
  }

  const initial = avatarInitial(me);

  return (
    <div className="space-y-5">
      <h3 className="text-base font-medium">Profile</h3>

      {/* Avatar + email */}
      <div className="flex items-center gap-4">
        <div className="relative">
          {me?.avatar ? (
            <img
              src={me.avatar}
              alt="Profile"
              className="h-16 w-16 rounded-full object-cover border border-border"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-primary/15 text-primary flex items-center justify-center text-2xl font-bold border border-border">
              {initial}
            </div>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploadAvatar.isPending}
            className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow hover:opacity-90 disabled:opacity-50"
            title="Change photo"
          >
            <Camera size={14} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={handleFile}
            className="hidden"
          />
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm">
            <Mail size={14} className="text-muted-foreground shrink-0" />
            <span className="font-medium truncate" data-private>{me?.email ?? "—"}</span>
          </div>
          {me?.avatar && (
            <button
              type="button"
              onClick={() => removeAvatar.mutate()}
              disabled={removeAvatar.isPending}
              className="mt-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              Remove photo
            </button>
          )}
        </div>
      </div>
      {avatarMsg && <p className="text-sm text-destructive">{avatarMsg}</p>}

      {/* Personal details */}
      <form
        onSubmit={(e) => { e.preventDefault(); saveProfile.mutate(); }}
        className="space-y-3"
      >
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="First name"
            autoComplete="given-name"
            placeholder="e.g. Jane"
            value={firstName}
            onChange={(e) => { setFirstName(e.target.value); setSavedMsg(""); }}
          />
          <Input
            label="Last name"
            autoComplete="family-name"
            placeholder="e.g. Smith"
            value={lastName}
            onChange={(e) => { setLastName(e.target.value); setSavedMsg(""); }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="profile-dob" className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            Date of birth
            <span className="relative group inline-flex items-center">
              <Info size={13} className="text-muted-foreground/70 hover:text-muted-foreground cursor-default transition-colors" />
              <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-56 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-normal text-muted-foreground shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed">
                Used to confirm you are an adult.
              </span>
            </span>
          </label>
          <input
            id="profile-dob"
            type="date"
            autoComplete="bday"
            value={dob}
            min={dobLimits.min}
            max={dobLimits.max}
            aria-invalid={dobProblem ? true : undefined}
            onChange={(e) => { setDob(e.target.value); setSavedMsg(""); }}
            className={cn(
              "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50",
              dobProblem && "border-destructive",
            )}
          />
          {dobProblem && <p className="text-xs text-destructive">{dobProblem}</p>}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="profile-phone" className="text-sm font-medium text-foreground">
            Phone number (optional)
          </label>
          <PhoneInput
            id="profile-phone"
            value={phone}
            onChange={(v) => { setPhone(v); setSavedMsg(""); }}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        {savedMsg && (
          <p className={cn("text-sm", savedMsg === "Saved." ? "text-success" : "text-destructive")}>
            {savedMsg}
          </p>
        )}
        <Button type="submit" loading={saveProfile.isPending} disabled={!dirty || !!dobProblem || !!phoneProblem}>
          Save profile
        </Button>
      </form>
    </div>
  );
}

function AccountTab() {
  // ── Logout ───────────────────────────────────────────────────────────────────
  const navigate = useNavigate();
  const clearToken = useAuthStore((s) => s.clearToken);
  async function handleLogout() {
    await api.post("/auth/logout").catch(() => {});
    clearToken();
    navigate("/login");
  }

  return (
    <div className="space-y-8 max-w-sm">
      <h2 className="text-xl font-semibold">My Account</h2>

      {/* Profile */}
      <ProfileCard />

      <hr className="border-border" />

      {/* Appearance / Theme */}
      <AppearanceCard />

      <hr className="border-border" />

      {/* Default Landing Page */}
      <DefaultLandingPageCard />

      <hr className="border-border" />

      {/* Display Mode */}
      <DisplayModeCard />

      <hr className="border-border" />

      {/* Sign out — near the bottom, where people look for it, but kept
          apart from the destructive actions in the Danger Zone below. */}
      <div className="space-y-3">
        <h3 className="text-base font-medium">Sign out</h3>
        <p className="text-sm text-muted-foreground">
          Sign out of Paiso on this device. You sign in again to get back in.
        </p>
        <Button variant="outline" onClick={handleLogout}>
          <LogOut size={14} />
          Sign out
        </Button>
      </div>

      <hr className="border-border" />

      {/* Danger Zone */}
      <DangerZone />
    </div>
  );
}


const MODE_OPTIONS: { id: Mode; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  // Gray is its own look, not "whatever the OS says" — it had been wearing the
  // Monitor icon, which is what System actually means.
  { id: "gray", label: "Gray", icon: Contrast },
  { id: "system", label: "System", icon: Monitor },
];

function AppearanceCard() {
  const { themeId, mode, setTheme, setMode } = useTheme();
  const themes = enabledThemes();

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium">Appearance</h3>
      <div className="rounded-xl border border-border bg-card p-5 space-y-5">
        {/* Mode */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Mode</p>
          <div className="inline-flex rounded-lg border border-border p-1 gap-1">
            {MODE_OPTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                aria-pressed={mode === id}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Theme */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Theme</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                aria-pressed={themeId === t.id}
                className={cn(
                  "group flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
                  themeId === t.id
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="flex h-8 w-full overflow-hidden rounded-md border border-border">
                  {t.swatch.map((c, i) => (
                    <span key={i} className="flex-1" style={{ backgroundColor: c }} />
                  ))}
                </div>
                {/* Labels and blurbs wrap rather than truncate — the names and
                    descriptions are the whole point of the picker. */}
                <div className="min-w-0">
                  <p className="text-sm font-medium break-words">{t.label}</p>
                  <p className="text-xs text-muted-foreground break-words">{t.description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DefaultLandingPageCard() {
  const defaultLandingPage = useUiPrefsStore((s) => s.defaultLandingPage);
  const setDefaultLandingPage = useUiPrefsStore((s) => s.setDefaultLandingPage);

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium">Default landing page</h3>
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <p className="text-sm text-muted-foreground">
          Choose the page the app opens to when you sign in or relaunch it.
        </p>
        <select
          value={
            NAV_ITEMS.some((i) => i.to === defaultLandingPage) ? defaultLandingPage : "/"
          }
          onChange={(e) => setDefaultLandingPage(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          {NAV_ITEMS.map((item) => (
            <option key={item.to} value={item.to}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DisplayModeCard() {
  const { mode, setMode } = useDisplayModeStore();
  const shown: DisplayMode = mode;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as DisplayMode;
    setMode(next);
    // Privacy mode rescales every formatter, which only a reload picks up.
    // Blur mode is drawn over the page, so it switches in place.
    if (next === "temu" || mode === "temu") window.location.reload();
  }

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium">Display mode</h3>
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <p className="text-sm text-muted-foreground">
          Control how monetary values are displayed across the app.
        </p>
        <select
          id="display-mode"
          value={shown}
          onChange={handleChange}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value="regular">Standard (default)</option>
          <option value="temu">Privacy mode: values ÷ 100</option>
          <option value="blur">Blur mode: hide amounts, names and account numbers</option>
        </select>
        {shown === "temu" && (
          <p className="text-xs text-muted-foreground italic">
            Privacy mode is on. Every amount is shown divided by 100, so the real figures stay private on a shared screen.
          </p>
        )}
        {shown === "blur" && (
          <p className="text-xs text-muted-foreground italic">
            Blur mode is on. Amounts, names and account numbers are blurred on this device; labels and charts keep their shape. Hover over an item to see it.
          </p>
        )}
      </div>
    </div>
  );
}

function DangerZone() {
  const { data: me } = useMe();
  const [resetConfirm, setResetConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // Re-authentication for these irreversible actions: the server now
  // requires the current password (and a 2FA code when enabled), so a stolen
  // session token can't wipe the account.
  const needsPassword = me ? me.has_password : true;
  const needsCode = me ? me.totp_enabled : false;
  const [pwd, setPwd] = useState("");
  const [code, setCode] = useState("");
  const noSecret = me ? (!me.has_password && !me.totp_enabled) : false;
  const reauthBody = () => ({
    ...(needsPassword ? { password: pwd } : {}),
    ...(needsCode ? { code } : {}),
  });
  const resetReady = (!needsPassword || pwd.length > 0) && (!needsCode || code.length > 0) && !noSecret;

  const resetData = useMutation({
    mutationFn: () => api.delete("/auth/data", reauthBody()),
    onSuccess: () => { window.location.reload(); },
  });

  const deleteAccount = useMutation({
    mutationFn: () => api.delete("/auth/account", reauthBody()),
    onSuccess: () => { window.location.href = "/login"; },
  });

  // Fields shown inside both confirm dialogs.
  const reauthFields = (idPrefix: string) => (
    noSecret ? (
      <p className="text-xs text-muted-foreground">
        This account has no password. Set one with the reset-password command first.
      </p>
    ) : (
      <div className="space-y-2">
        {needsPassword && (
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            aria-label="Current password"
            id={`${idPrefix}-pwd`}
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs"
          />
        )}
        {needsCode && (
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Authenticator or recovery code"
            aria-label="Authenticator or recovery code"
            id={`${idPrefix}-code`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs"
          />
        )}
      </div>
    )
  );

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium text-destructive">Danger zone</h3>
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-4">

        {/* Reset all data */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Reset all data</p>
          <p className="text-xs text-muted-foreground">
            Permanently erases all your financial data, including accounts, transactions and plans. Your sign-in stays. This cannot be undone.
          </p>
          {resetConfirm ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive font-medium">
                Are you absolutely sure? All your data will be permanently deleted and cannot be recovered.
              </p>
              {reauthFields("reset")}
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={() => resetData.mutate()}
                  loading={resetData.isPending}
                  disabled={!resetReady}
                >
                  <Trash2 size={13} />
                  Yes, delete all my data
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setResetConfirm(false)}
                  disabled={resetData.isPending}
                >
                  Cancel
                </Button>
              </div>
              {resetData.isError && (
                <p className="text-xs text-destructive">{(resetData.error as Error).message}</p>
              )}
            </div>
          ) : (
            <button
              onClick={() => { setDeleteConfirm(false); setResetConfirm(true); }}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
            >
              <AlertTriangle size={13} />
              Reset all data
            </button>
          )}
        </div>

        <hr className="border-destructive/20" />

        {/* Delete account */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Delete account</p>
          <p className="text-xs text-muted-foreground">
            Permanently deletes your account and all associated data. You will be signed out immediately. This cannot be undone.
          </p>
          {deleteConfirm ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive font-medium">
                Are you absolutely sure? Your account and all data will be permanently deleted and cannot be recovered.
              </p>
              {reauthFields("delete")}
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={() => deleteAccount.mutate()}
                  loading={deleteAccount.isPending}
                  disabled={!resetReady}
                >
                  <Trash2 size={13} />
                  Yes, delete my account
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={deleteAccount.isPending}
                >
                  Cancel
                </Button>
              </div>
              {deleteAccount.isError && (
                <p className="text-xs text-destructive">{(deleteAccount.error as Error).message}</p>
              )}
            </div>
          ) : (
            <button
              onClick={() => { setResetConfirm(false); setDeleteConfirm(true); }}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
            >
              <Trash2 size={13} />
              Delete account
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
