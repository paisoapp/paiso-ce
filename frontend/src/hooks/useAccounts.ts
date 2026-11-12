import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Account, AccountClassification } from "@/types";

const QK = "accounts";

/** The investment kinds, purposes and tax treatments the account forms offer.
 *  Static per deploy, so it is fetched once. */
export function useAccountClassification() {
  return useQuery<AccountClassification>({
    queryKey: ["account-classification"],
    queryFn: () => api.get<AccountClassification>("/accounts/classification"),
    staleTime: Infinity,
  });
}

export function useAccounts() {
  return useQuery<Account[]>({
    queryKey: [QK],
    queryFn: () => api.get<Account[]>("/accounts"),
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      display_name: string;
      account_type: string;
      institution_name?: string;
      currency?: string;
      current_balance?: number | null;
      credit_limit?: number | null;
      description_pattern?: string | null;
      investment_type?: string | null;
      subtype?: string | null;
    }) => api.post<Account>("/accounts", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useCreateMortgage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      /** An existing mortgage/loan account to put behind the property instead
       *  of creating a new one. */
      account_id?: number | null;
      display_name: string;
      institution_name?: string;
      description_pattern?: string | null;
      property_address: string;
      category: string;
      current_value?: number | null;
      acquired_value?: number | null;
      acquired_at?: string | null;
      ownership_pct?: number;
      zillow_url?: string | null;
      principal: number;
      rate_apr: number;
      term_months: number;
      origination: string;
      extra_principal_monthly?: number;
      insurance_monthly?: number;
      property_tax_monthly?: number;
    }) => api.post<{ account: Account; asset: unknown }>("/mortgage", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["assets"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: number;
      display_name?: string;
      currency?: string;
      account_type?: string;
      institution_name?: string;
      current_balance?: number | null;
      credit_limit?: number | null;
      description_pattern?: string | null;
      investment_type?: string | null;
      subtype?: string | null;
      other_funds_value?: number | null;
      contributions_total?: number | null;
      hsa_coverage?: "self" | "family" | null;
      exclude_from_net_worth?: boolean;
    }) => api.patch<Account>(`/accounts/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["holdings"] });
    },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    /** `deleteProperty`: for a mortgage behind a property, delete the property
     *  too. Its loan goes with the account either way. */
    mutationFn: (arg: number | { id: number; deleteProperty?: boolean }) => {
      const { id, deleteProperty } = typeof arg === "number" ? { id: arg, deleteProperty: false } : arg;
      return api.delete(`/accounts/${id}${deleteProperty ? "?delete_property=true" : ""}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}
