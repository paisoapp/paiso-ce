import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface LoanScheduleRow {
  month_number: number;
  payment_date: string;
  principal: number;
  interest: number;
  escrow: number;
  balance: number;
}

export interface AssetLoan {
  id: number;
  principal: number;
  rate_apr: number;
  term_months: number;
  origination: string;
  extra_principal_monthly: number;
  insurance_monthly: number;
  property_tax_monthly: number;
  /** Escrow read from the mortgage payments, used when insurance and tax are empty. */
  escrow_monthly?: number | null;
  /** "payments": Paiso filled it in from the payments; "user": typed. */
  escrow_source?: "payments" | "user" | null;
  extra_principal_source?: "payments" | "user" | null;
  balance_override: number | null;
  balance_override_date: string | null;
  current_balance: number;
  monthly_payment: number;
  schedule: LoanScheduleRow[];
}

export interface Asset {
  id: number;
  category: string;
  name: string;
  ownership_pct: number;
  current_value: number | null;
  acquired_value: number | null;
  acquired_at: string | null;
  metadata_json: Record<string, unknown> | null;
  loan: AssetLoan | null;
}

const QK = "assets";

export function useAssets() {
  return useQuery<Asset[]>({ queryKey: [QK], queryFn: () => api.get<Asset[]>("/assets") });
}

export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      category: string;
      name: string;
      ownership_pct?: number;
      current_value?: number;
      acquired_value?: number;
      acquired_at?: string;
      metadata_json?: Record<string, unknown>;
      loan?: {
        principal: number;
        rate_apr: number;
        term_months: number;
        origination: string;
        extra_principal_monthly?: number;
        insurance_monthly?: number;
        property_tax_monthly?: number;
      };
    }) => api.post<Asset>("/assets", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useUpdateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: number;
      current_value?: number;
      name?: string;
      category?: string;
      acquired_value?: number;
      acquired_at?: string;
      ownership_pct?: number;
      metadata_json?: Record<string, unknown>;
      loan?: {
        principal?: number;
        rate_apr?: number;
        term_months?: number;
        origination?: string;
        balance_override?: number | null;
        balance_override_date?: string | null;
        extra_principal_monthly?: number;
        insurance_monthly?: number;
        property_tax_monthly?: number;
        clear_override?: boolean;
      };
    }) => api.patch<Asset>(`/assets/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation({
    /** `deleteAccounts`: also delete the hand-added accounts linked to it
     *  (the mortgage account Add Property made). Synced ones are kept. */
    mutationFn: (arg: number | { id: number; deleteAccounts?: boolean }) => {
      const { id, deleteAccounts } = typeof arg === "number" ? { id: arg, deleteAccounts: false } : arg;
      return api.delete(`/assets/${id}${deleteAccounts ? "?delete_accounts=true" : ""}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}
