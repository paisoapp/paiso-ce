export interface Account {
  id: number;
  display_name: string;
  account_type: string;
  currency: string;
  /** Left out of every total (an investment account valued as one number). */
  exclude_from_net_worth?: boolean;
  institution_name: string | null;
  current_balance: number | null;
  balance_as_of: string | null;
  credit_limit: number | null;
  linked_asset_id: number | null;
  description_pattern: string | null;
  /** APR / statement / payment detail. Present on cards, loans and mortgages. */
  liability: AccountLiability | null;
  /** What an investment account is for, i.e. the Investments tab it is on:
   *  investing (Stocks & Funds), retirement, education, health. */
  investment_type?: string | null;
  investment_type_label?: string | null;
  /** Its legal structure ("403B", "roth"), which decides
   *  the tax treatment. */
  subtype?: string | null;
  subtype_label?: string | null;
  tax_treatment?: string | null;
  tax_treatment_label?: string | null;
  /** The user picked the type/sub-type; a sync leaves them alone. */
  classification_set_by_user?: boolean;
  /** A hand-kept plan: what it holds beyond its tickers, as last entered. */
  other_funds_value?: number | null;
  other_funds_as_of?: string | null;
  other_funds_prev_value?: number | null;
  contributions_total?: number | null;
}

export interface AccountSubtypeOption {
  value: string;
  label: string;
  tax_treatment: string | null;
  tax_treatment_label: string | null;
  /** The coarse account_type this subtype implies. */
  account_type: string;
}

export interface AccountClassification {
  types: { value: string; label: string; subtypes: AccountSubtypeOption[] }[];
}

export interface AccountLiability {
  kind: string | null;
  apr_pct: number | null;
  apr_type: string | null;
  minimum_payment: number | null;
  next_payment_due_date: string | null;
  next_monthly_payment: number | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  last_statement_balance: number | null;
  last_statement_date: string | null;
  origination_date: string | null;
  origination_principal: number | null;
  maturity_date: string | null;
  expected_payoff_date: string | null;
  term_months: number | null;
  escrow_balance: number | null;
  is_overdue: boolean | null;
  has_pmi: boolean | null;
}

export interface Category {
  id: number;
  name: string;
  is_income: boolean;
  parent_id: number | null;
  /** An emoji; older rows held an icon name such as "circle". */
  icon: string | null;
  color: string | null;
  /** How its transactions count: "income", "expense" or "transfer". */
  treatment?: string | null;
  /** A top-level group holding categories, rather than a category. */
  is_group?: boolean;
  /** Order inside its group. */
  position?: number;
}

export interface Transaction {
  id: number;
  account_id: number;
  account_name: string | null;
  date_posted: string;
  description: string;
  amount: number;
  transaction_type: string | null;
  balance: number | null;
  member_name: string | null;
  category_id: number | null;
  category_name: string | null;
  notes: string | null;
  tags: string | null;
  source: string | null;
  is_duplicate: boolean;
  /** Not yet settled at the bank. Shown in the ledger, excluded from totals. */
  pending: boolean;
  /** Normalised counterparty from the bank; `description` stays user-editable. */
  merchant_name: string | null;
  date_authorized: string | null;
  /** The other leg of this movement, when the two have been paired. */
  transfer: {
    link_id: number;
    status: "suggested" | "confirmed";
    kind: string;
    confidence: number;
    /** Which signals matched, and whether a person or the matcher decided.
     *  A pair the matcher confirmed on its own is an automated
     *  recategorisation; these are what let someone see why before undoing it. */
    matched_on: string | null;
    source: string;
    counterpart_transaction_id: number;
    counterpart_account_name: string | null;
    counterpart_date: string | null;
    counterpart_amount: number | null;
    counterpart_description: string | null;
  } | null;
}

export interface PaginatedTransactions {
  items: Transaction[];
  total: number;
  total_amount: number;
  page: number;
  page_size: number;
}

export type AccountTypeGroup = "cash" | "investments" | "credit_cards" | "loan" | "mortgage";

export interface TransactionAttachment {
  id: number;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: string;
}

export interface CsvPreview {
  upload_id: string;
  columns: string[];
  sample_rows: Record<string, string>[];
  encoding: string;
  delimiter: string;
}

export interface CommitResult {
  imported: number;
  skipped: number;
}

export interface InvalidCsvRow {
  row_index: number;
  raw: Record<string, string>;
  partial: Record<string, unknown>;
  errors: Record<string, string>;
  /** User-supplied corrections, keyed by canonical field name */
  corrected?: Record<string, string>;
}

export interface ValidationResult {
  valid_count: number;
  invalid_rows: InvalidCsvRow[];
}

export interface BankImportResult {
  imported: number;
  skipped: number;
  institution: string;
  balance_found: boolean;
}
