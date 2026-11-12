import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface Me {
  email: string;
  first_name: string | null;
  last_name: string | null;
  dob: string | null;
  phone: string | null;
  avatar: string | null;
  totp_enabled: boolean;
  must_change_password: boolean;
  mfa_setup_required: boolean;
  /** Whether the account has a password hash. */
  has_password: boolean;
  /** When the account was opened (ISO). */
  created_at: string | null;
}

/** How long a new account counts as new, for the tips aimed at new users. */
const NEW_ACCOUNT_DAYS = 14;

/** True for an account opened in the last `NEW_ACCOUNT_DAYS` days. False
 *  while `me` is loading, so a new-user tip never flashes up for an
 *  established account. */
export function isNewAccount(me: Me | undefined): boolean {
  if (!me?.created_at) return false;
  const opened = Date.parse(me.created_at);
  return Number.isFinite(opened) && Date.now() - opened < NEW_ACCOUNT_DAYS * 86_400_000;
}

/** Best display name: full name, then first/last alone, then email local-part. */
export function displayName(me: Me | undefined): string {
  if (!me) return "";
  const full = [me.first_name, me.last_name].filter(Boolean).join(" ").trim();
  return full || me.email;
}

/** The letter on an avatar with no photo: the first letter of the name the
 *  app greets the user by, so the sidebar and My Account agree. */
export function avatarInitial(me: Me | undefined): string {
  return (displayName(me)[0] ?? "?").toUpperCase();
}

export function useMe() {
  return useQuery<Me>({
    queryKey: ["auth-me"],
    queryFn: () => api.get<Me>("/auth/me"),
    staleTime: 60_000,
    // Also the session check. A device signed out from elsewhere ("Sign out
    // all other devices", a password change) used to find out only on its
    // next click. Asked once a minute while the tab is in view, it leaves
    // for the sign-in page by itself.
    refetchInterval: 60_000,
  });
}
