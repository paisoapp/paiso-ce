import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { BankImportResult, CommitResult, CsvPreview, ValidationResult } from "@/types";

export function useSetAccountBalance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, balance, asOfDate }: { accountId: number; balance: number; asOfDate: string }) =>
      api.post(`/accounts/${accountId}/balance`, { balance, as_of_date: asOfDate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useUploadCsv() {
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.upload<CsvPreview>("/imports/csv", fd);
    },
  });
}

export function useValidateCsv() {
  return useMutation({
    mutationFn: (body: {
      upload_id: string;
      account_id: number;
      column_map: Record<string, string>;
      amount_debit_column?: string | null;
      amount_credit_column?: string | null;
    }) => api.post<ValidationResult>(`/imports/csv/${body.upload_id}/validate`, body),
  });
}

export function useCommitCsv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      upload_id: string;
      account_id: number;
      column_map: Record<string, string>;
      amount_debit_column?: string | null;
      amount_credit_column?: string | null;
      save_mapping?: boolean;
      corrections?: Array<{ row_index: number; fields: Record<string, string> }>;
    }) => api.post<CommitResult>(`/imports/csv/${body.upload_id}/commit`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useSavedCsvMapping(accountId: number | null) {
  return useQuery({
    queryKey: ["csv-mapping", accountId],
    queryFn: () => api.get<{
      column_map: Record<string, string>;
      amount_debit_column: string | null;
      amount_credit_column: string | null;
    } | null>(`/imports/csv/${accountId}/mapping`),
    enabled: accountId != null && accountId > 0,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBankCsvImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, accountId }: { file: File; accountId: number }) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", String(accountId));
      return api.upload<BankImportResult>("/imports/bank-csv", fd);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

/** What a CSV import would do, from `/imports/bank-csv` with `preview`.
 *  Nothing is written until the user confirms. */
export interface BankImportPreview {
  institution: string;
  row_count: number;
  new_count: number;
  duplicate_count: number;
  unreadable: { line: number; values: string[]; reason: string }[];
  date_from: string | null;
  date_to: string | null;
  sample: { date: string; description: string; amount: number }[];
  balance_found: boolean;
}

export function useBankCsvPreview() {
  return useMutation({
    mutationFn: ({ file, accountId }: { file: File; accountId: number }) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", String(accountId));
      fd.append("preview", "true");
      return api.upload<BankImportPreview>("/imports/bank-csv", fd);
    },
  });
}

// ── OFX / QFX ────────────────────────────────────────────────────────────────

/** One account's statement inside an OFX or QFX file, as the server read it. */
export interface OfxStatement {
  index: number;
  kind: "bank" | "card" | "investment";
  account_type: string | null;
  account_last4: string | null;
  transaction_count: number;
  new_count: number;
  already_imported: number;
  date_from: string | null;
  date_to: string | null;
  balance: number | null;
  balance_as_of: string | null;
  /** Rows in the file with no date or no amount. */
  unreadable: number;
  trade_count: number;
  position_count: number;
  income_count: number;
  /** Dividends the import would record: new ones on holdings kept by trades. */
  income_new: number;
  /** False when the statement's kind does not fit the chosen account. */
  fits_account: boolean;
  sample: { date: string; description: string; amount: number }[];
}

export interface OfxPreview {
  statements: OfxStatement[];
  suggested_index: number | null;
}

interface OfxImportResult {
  imported: number;
  skipped: number;
  unreadable: number;
  income_recorded: number;
  balance_updated: boolean;
  /** Holdings created and updated from an investment statement's positions,
   *  and positions left alone on holdings kept by trades. */
  holdings_created: number;
  holdings_updated: number;
  holdings_kept: number;
}

function ofxForm(file: File, accountId: number, statementIndex?: number): FormData {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("account_id", String(accountId));
  if (statementIndex != null) fd.append("statement_index", String(statementIndex));
  return fd;
}

/** Reads the file against the account and says what importing it would do.
 *  Nothing is written. */
export function useOfxPreview() {
  return useMutation({
    mutationFn: ({ file, accountId }: { file: File; accountId: number }) =>
      api.upload<OfxPreview>("/imports/ofx/preview", ofxForm(file, accountId)),
  });
}

export function useOfxImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, accountId, statementIndex }: { file: File; accountId: number; statementIndex: number }) =>
      api.upload<OfxImportResult>("/imports/ofx", ofxForm(file, accountId, statementIndex)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["holdings"] });
    },
  });
}
