import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** GET /api/info: the version, the channel and whether sign-up is open, public. */
interface AppInfo {
  version: string;
  /** Ends in the short commit, e.g. "2026.10.20.0446-75735cb". */
  version_string: string;
  channel: string;
  /** True until the one account exists; then sign-up is closed (Q12). */
  signup_open: boolean;
}

export function useAppInfo() {
  return useQuery<AppInfo>({
    queryKey: ["app-info"],
    queryFn: () => api.get<AppInfo>("/info"),
    staleTime: 5 * 60_000,
  });
}
