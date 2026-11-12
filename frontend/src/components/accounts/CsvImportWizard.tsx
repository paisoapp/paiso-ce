import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Upload } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  useBankCsvImport,
  useBankCsvPreview,
  useCommitCsv,
  useOfxImport,
  useOfxPreview,
  useSavedCsvMapping,
  useSetAccountBalance,
  useUploadCsv,
  useValidateCsv,
  type BankImportPreview,
  type OfxPreview,
} from "@/hooks/useImports";
import { useAccounts } from "@/hooks/useAccounts";
import { ApiError } from "@/lib/api";
import type { CsvPreview, InvalidCsvRow } from "@/types";
import { cn, formatCurrencyFull } from "@/lib/utils";
import { EARLIEST_DATE, todayIso } from "@/lib/validation";
import { UPLOAD_LIMITS, tooLarge } from "@/lib/uploadLimits";
import { formatDate } from "@/lib/dates";
import { MoneyInput } from "@/components/ui/MoneyInput";

const CANONICAL = [
  { key: "date_posted", label: "Date", required: true },
  { key: "description", label: "Description", required: true },
  { key: "amount", label: "Amount (signed)" },
  { key: "balance", label: "Balance" },
  { key: "transaction_type", label: "Transaction Type" },
  // The bank's own category label: the categorizer maps it to a category.
  { key: "bank_category", label: "Category" },
  { key: "notes", label: "Notes" },
  { key: "tags", label: "Tags" },
];

type Step = "upload" | "ofx" | "confirm" | "map" | "review" | "set-balance" | "done";

/** The file a bank offers as a Quicken, Money or QuickBooks download. All
 *  three extensions are the same format. */
const OFX_FILE = /\.(ofx|qfx|qbo)$/i;

const OFX_KIND: Record<string, string> = {
  bank: "Bank account",
  card: "Credit card",
  investment: "Investment account",
};

/** The account type as the file names it, where that says more than the kind:
 *  a file with a checking and a savings account should not list two "bank
 *  accounts". */
const OFX_ACCOUNT_TYPE: Record<string, string> = {
  CHECKING: "Checking account",
  SAVINGS: "Savings account",
  MONEYMRKT: "Money market account",
  CD: "Certificate of deposit",
};

interface ImportSummary {
  imported: number;
  skipped: number;
  institution?: string;
  /** Dividends an investment file added to holdings. */
  incomeRecorded?: number;
  /** Holdings an investment file's positions created, updated or left alone. */
  holdingsCreated?: number;
  holdingsUpdated?: number;
  holdingsKept?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: number;
  accountName: string;
}

function autoMap(columns: string[]): Record<string, string> {
  const auto: Record<string, string> = {};
  const lower = columns.map((c) => c.toLowerCase());

  const find = (tests: RegExp[]) =>
    columns[lower.findIndex((c) => tests.some((r) => r.test(c)))] ?? "";

  auto["date_posted"] = find([/\bdate\b/, /date_posted/, /trans.*date/, /posted/]);
  auto["description"] = find([/\bdesc/i, /\bmemo\b/, /\bname\b/, /narrat/, /detail/, /payee/]);
  auto["amount"] = find([/\bamount\b/, /\bamt\b/, /\bvalue\b/]);
  auto["balance"] = find([/\bbalance\b/, /running.*bal/, /bal\b/]);
  auto["transaction_type"] = find([/\btype\b/, /txn.*type/, /trans.*type/]);
  auto["bank_category"] = find([/\bcategor/]);
  auto["notes"] = find([/\bnotes?\b/, /\bmemo\b/, /\bcomment/]);
  auto["tags"] = find([/\btags?\b/, /\blabel/]);

  for (const k of Object.keys(auto)) {
    if (!auto[k]) delete auto[k];
  }
  return auto;
}

export function CsvImportWizard({ open, onClose, accountId, accountName }: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [debitCol, setDebitCol] = useState("");
  const [creditCol, setCreditCol] = useState("");
  const [useSplitAmount, setUseSplitAmount] = useState(false);
  const [invalidRows, setInvalidRows] = useState<InvalidCsvRow[]>([]);
  const [validCount, setValidCount] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [manualBalance, setManualBalance] = useState("");
  const [balanceError, setBalanceError] = useState("");
  const [asOfDate, setAsOfDate] = useState(todayIso);
  const [fallbackNotice, setFallbackNotice] = useState(false);
  // A file over the limit is refused here, before it is sent.
  const [sizeError, setSizeError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const smartImport = useBankCsvImport();
  // A recognised CSV is read first and shown, then imported on Confirm.
  const csvPreviewCheck = useBankCsvPreview();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvPreview, setCsvPreview] = useState<BankImportPreview | null>(null);
  const { data: accounts } = useAccounts();
  const currentBalance = accounts?.find((a) => a.id === accountId)?.current_balance ?? null;
  const upload = useUploadCsv();
  const validate = useValidateCsv();
  const commit = useCommitCsv();
  const setBalance = useSetAccountBalance();
  const savedMapping = useSavedCsvMapping(accountId);

  // OFX and QFX need no column mapping, so they take their own short path:
  // read the file, show what it holds, import on confirm.
  const ofxPreview = useOfxPreview();
  const ofxImport = useOfxImport();
  const [ofxFile, setOfxFile] = useState<File | null>(null);
  const [ofx, setOfx] = useState<OfxPreview | null>(null);
  const [ofxIndex, setOfxIndex] = useState(0);

  const busy = smartImport.isPending || csvPreviewCheck.isPending || upload.isPending || validate.isPending || commit.isPending
    || ofxPreview.isPending || ofxImport.isPending;

  const reset = useCallback(() => {
    setStep("upload");
    setPreview(null);
    setColumnMap({});
    setDebitCol("");
    setCreditCol("");
    setUseSplitAmount(false);
    setInvalidRows([]);
    setValidCount(0);
    setSummary(null);
    setManualBalance("");
    setAsOfDate(todayIso());
    setCsvFile(null);
    setCsvPreview(null);
    csvPreviewCheck.reset();
    setFallbackNotice(false);
    setOfxFile(null);
    setOfx(null);
    setOfxIndex(0);
    ofxPreview.reset();
    ofxImport.reset();
    smartImport.reset();
    upload.reset();
    validate.reset();
    commit.reset();
    setBalance.reset();
  }, [smartImport, csvPreviewCheck, upload, validate, commit, setBalance, ofxPreview, ofxImport]);

  const handleClose = () => { reset(); onClose(); };

  useEffect(() => {
  }, [step]);

  // Apply saved mapping once we're in the manual-mapping step and columns are known.
  useEffect(() => {
    if (step !== "map" || !preview || !savedMapping.data) return;
    const m = savedMapping.data;
    if (m.column_map && Object.keys(m.column_map).length) setColumnMap(m.column_map);
    if (m.amount_debit_column) { setDebitCol(m.amount_debit_column); setUseSplitAmount(true); }
    if (m.amount_credit_column) { setCreditCol(m.amount_credit_column); setUseSplitAmount(true); }
  }, [step, preview, savedMapping.data]);

  // The balance prompt starts from what the account holds now, not $0: most
  // people only need to check it.
  useEffect(() => {
    if (step === "set-balance" && manualBalance === "" && currentBalance != null) {
      setManualBalance(String(currentBalance));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Step 1: file dropped — read it with the smart parser, then confirm ─────
  async function handleFile(file: File) {
    setFallbackNotice(false);
    const isOfx = OFX_FILE.test(file.name);
    const big = isOfx
      ? tooLarge(file, UPLOAD_LIMITS.statement, "A statement file")
      : tooLarge(file, UPLOAD_LIMITS.csv, "A CSV file");
    setSizeError(big);
    if (big) return;
    if (isOfx) {
      smartImport.reset();
      upload.reset();
      try {
        const p = await ofxPreview.mutateAsync({ file, accountId });
        setOfxFile(file);
        setOfx(p);
        setOfxIndex(p.suggested_index ?? 0);
        setStep("ofx");
      } catch {
        // Stays on the upload step; the reason shows from ofxPreview.error.
      }
      return;
    }
    ofxPreview.reset();
    smartImport.reset();
    try {
      // Nothing is written yet: the user sees what Paiso read, including the
      // rows it cannot, and imports on Confirm.
      const p = await csvPreviewCheck.mutateAsync({ file, accountId });
      setCsvFile(file);
      setCsvPreview(p);
      setStep("confirm");
    } catch (err) {
      // 422 = couldn't smartly map this CSV → fall back to the manual mapping wizard.
      if (err instanceof ApiError && err.status === 422) {
        const p = await upload.mutateAsync(file);
        setPreview(p);
        setColumnMap(savedMapping.data?.column_map ?? autoMap(p.columns));
        if (savedMapping.data?.amount_debit_column) { setDebitCol(savedMapping.data.amount_debit_column); setUseSplitAmount(true); }
        if (savedMapping.data?.amount_credit_column) { setCreditCol(savedMapping.data.amount_credit_column); setUseSplitAmount(true); }
        setFallbackNotice(true);
        setStep("map");
      }
      // Any other error stays on the upload step and is surfaced via csvPreviewCheck.error.
    }
  }

  async function handleCsvImport() {
    if (!csvFile) return;
    const r = await smartImport.mutateAsync({ file: csvFile, accountId });
    setSummary({ imported: r.imported, skipped: r.skipped, institution: r.institution });
    setStep(r.balance_found ? "done" : "set-balance");
  }

  /** The detected format is wrong: map the columns by hand instead. */
  async function mapByHand() {
    if (!csvFile) return;
    const p = await upload.mutateAsync(csvFile);
    setPreview(p);
    setColumnMap(savedMapping.data?.column_map ?? autoMap(p.columns));
    setFallbackNotice(false);
    setStep("map");
  }

  async function handleOfxImport() {
    if (!ofxFile) return;
    const r = await ofxImport.mutateAsync({ file: ofxFile, accountId, statementIndex: ofxIndex });
    setSummary({
      imported: r.imported, skipped: r.skipped, incomeRecorded: r.income_recorded,
      holdingsCreated: r.holdings_created, holdingsUpdated: r.holdings_updated, holdingsKept: r.holdings_kept,
    });
    // A statement that carried no balance leaves the account's balance to
    // the person, as a CSV with no balance column does. An account valued by
    // the holdings its positions just set needs no balance.
    const positioned = r.holdings_created + r.holdings_updated + r.holdings_kept > 0;
    setStep(r.balance_updated || positioned ? "done" : "set-balance");
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // ── Manual mapping: validate, then commit (or branch to review) ────────────
  async function handleValidateAndCommit() {
    if (!preview) return;
    const v = await validate.mutateAsync({
      upload_id: preview.upload_id,
      account_id: accountId,
      column_map: columnMap,
      amount_debit_column: useSplitAmount ? debitCol || null : null,
      amount_credit_column: useSplitAmount ? creditCol || null : null,
    });
    setValidCount(v.valid_count);

    if (v.invalid_rows.length > 0) {
      // Stop for the user to fix malformed rows before saving.
      setInvalidRows(v.invalid_rows.map((row) => ({ ...row, corrected: {} })));
      setStep("review");
    } else {
      // Cleanly mapped → save directly, no preview.
      await doCommit([]);
    }
  }

  async function doCommit(corrections: Array<{ row_index: number; fields: Record<string, string> }>) {
    if (!preview) return;
    const r = await commit.mutateAsync({
      upload_id: preview.upload_id,
      account_id: accountId,
      column_map: columnMap,
      amount_debit_column: useSplitAmount ? debitCol || null : null,
      amount_credit_column: useSplitAmount ? creditCol || null : null,
      corrections,
    });
    setSummary({ imported: r.imported, skipped: r.skipped });
    setStep("done");
  }

  async function handleCommitWithFixes() {
    const corrections = invalidRows
      .filter((row) => row.corrected && Object.keys(row.corrected).length > 0)
      .map((row) => ({ row_index: row.row_index, fields: row.corrected! }));
    await doCommit(corrections);
  }

  async function handleSaveBalance() {
    const value = parseFloat(manualBalance);
    if (isNaN(value)) {
      setBalanceError("Enter the balance, or choose Skip.");
      return;
    }
    setBalanceError("");
    await setBalance.mutateAsync({ accountId, balance: value, asOfDate });
    setStep("done");
  }

  function updateCorrection(rowIndex: number, field: string, value: string) {
    setInvalidRows((rows) =>
      rows.map((r) =>
        r.row_index === rowIndex
          ? { ...r, corrected: { ...r.corrected, [field]: value } }
          : r
      )
    );
  }

  const NONE = "__none__";
  const cols = preview?.columns ?? [];
  const canCommitMapping =
    !!columnMap["date_posted"] &&
    !!columnMap["description"] &&
    (!useSplitAmount ? !!columnMap["amount"] : !!debitCol && !!creditCol);

  return (
    <Dialog open={open} onClose={handleClose} closeOnBackdrop={false} className={step === "map" || step === "review" ? "max-w-2xl" : "max-w-lg"}>
      <DialogHeader onClose={handleClose}>Import into {accountName}</DialogHeader>

      {/* ── Step 1: Upload (smart import attempt) ──────────────────────────── */}
      {step === "upload" && (
        <>
          <DialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a file from your bank or card issuer: a CSV statement, or the OFX or QFX file it offers for Quicken. Paiso reads OFX and QFX files as they are. It detects most CSV formats, and asks you to match the columns when it cannot.
            </p>
            <div
              className={cn(
                "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors",
                dragOver ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground",
                busy && "pointer-events-none opacity-60",
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => !busy && fileRef.current?.click()}
            >
              <Upload size={28} className="text-muted-foreground" />
              {busy ? (
                <p className="text-sm text-muted-foreground">Processing…</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Drag and drop a file, or <span className="text-primary underline">browse</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    .csv under 5 MB and 1,000 rows · .ofx, .qfx under 10 MB
                  </p>
                </>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,.ofx,.qfx,.qbo"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
              />
            </div>
            {sizeError && <p className="text-sm text-destructive">{sizeError}</p>}
            {csvPreviewCheck.error && !(csvPreviewCheck.error instanceof ApiError && csvPreviewCheck.error.status === 422) && (
              <p className="text-sm text-destructive">{(csvPreviewCheck.error as Error).message}</p>
            )}
            {upload.error && (
              <p className="text-sm text-destructive">{(upload.error as Error).message}</p>
            )}
            {ofxPreview.error && (
              <p className="text-sm text-destructive">{(ofxPreview.error as Error).message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Paiso skips transactions the account already has, so you can import files whose dates overlap.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          </DialogFooter>
        </>
      )}

      {/* ── OFX / QFX: what the file holds, then import ────────────────────── */}
      {step === "ofx" && ofx && (
        <OfxReview
          preview={ofx}
          index={ofxIndex}
          onIndex={setOfxIndex}
          accountName={accountName}
          error={ofxImport.error ? (ofxImport.error as Error).message : null}
          importing={ofxImport.isPending}
          onBack={reset}
          onImport={handleOfxImport}
        />
      )}

      {/* ── CSV: what Paiso read, then import ──────────────────────────────── */}
      {step === "confirm" && csvPreview && (
        <CsvReview
          preview={csvPreview}
          accountName={accountName}
          error={(smartImport.error || upload.error) ? ((smartImport.error || upload.error) as Error).message : null}
          importing={smartImport.isPending}
          onBack={reset}
          onMapByHand={mapByHand}
          onImport={handleCsvImport}
        />
      )}

      {/* ── Step 2: Column Mapping (fallback) ──────────────────────────────── */}
      {step === "map" && preview && (
        <>
          <DialogBody className="space-y-4">
            {fallbackNotice && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
                <span>
                  Paiso could not detect this format. Map each field to a CSV column below.
                  {savedMapping.data ? " Your saved mapping for this account is pre-filled." : ""}
                </span>
              </div>
            )}
            <p className="text-sm text-muted-foreground">Detected {cols.length} columns.</p>

            <div className="space-y-3">
              {CANONICAL.map(({ key, label, required }) => (
                <div key={key} className="grid grid-cols-2 gap-3 items-center">
                  <span className="text-sm font-medium">
                    {label}
                    {required && <span className="text-destructive ml-0.5">*</span>}
                  </span>
                  <Select
                    value={columnMap[key] ?? NONE}
                    onChange={(e) => {
                      const v = e.target.value;
                      setColumnMap((m) => ({ ...m, [key]: v === NONE ? "" : v }));
                    }}
                  >
                    <option value={NONE}>Not mapped</option>
                    {cols.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={useSplitAmount}
                onChange={(e) => setUseSplitAmount(e.target.checked)}
                className="rounded border-border"
              />
              Use separate Debit / Credit columns
            </label>

            {useSplitAmount && (
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Debit column"
                  value={debitCol || NONE}
                  onChange={(e) => setDebitCol(e.target.value === NONE ? "" : e.target.value)}
                >
                  <option value={NONE}>Select a column</option>
                  {cols.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
                <Select
                  label="Credit column"
                  value={creditCol || NONE}
                  onChange={(e) => setCreditCol(e.target.value === NONE ? "" : e.target.value)}
                >
                  <option value={NONE}>Select a column</option>
                  {cols.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
            )}

            {/* Mapping aid: live view of how the first rows map */}
            {preview.sample_rows.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mapped preview</p>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted">
                      <tr>
                        {CANONICAL.filter((c) => columnMap[c.key]).map((c) => (
                          <th key={c.key} className="px-3 py-1.5 text-left font-medium">{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {preview.sample_rows.map((row, i) => (
                        <tr key={i}>
                          {CANONICAL.filter((c) => columnMap[c.key]).map((c) => (
                            <td key={c.key} className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                              {row[columnMap[c.key]] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {(validate.error || commit.error) && (
              <p className="text-sm text-destructive">{((validate.error || commit.error) as Error).message}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { reset(); }}>Start over</Button>
            <Button onClick={handleValidateAndCommit} disabled={!canCommitMapping} loading={validate.isPending || commit.isPending}>
              {validate.isPending ? "Checking rows…" : commit.isPending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </>
      )}

      {/* ── Step 3: Review malformed rows ─────────────────────────────────── */}
      {step === "review" && (
        <>
          <DialogBody className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
              <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">
                  {invalidRows.length} row{invalidRows.length !== 1 ? "s" : ""} need attention
                </p>
                <p className="text-xs text-muted-foreground">
                  {validCount} row{validCount !== 1 ? "s" : ""} are valid. Fix the issues below, or
                  leave a row as-is to skip it.
                </p>
              </div>
            </div>

            <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
              {invalidRows.map((row) => (
                <MalformedRowEditor
                  key={row.row_index}
                  row={row}
                  columnMap={columnMap}
                  debitCol={debitCol}
                  creditCol={creditCol}
                  onCorrect={(field, value) => updateCorrection(row.row_index, field, value)}
                />
              ))}
            </div>
            {commit.error && (
              <p className="text-sm text-destructive">{(commit.error as Error).message}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStep("map")}>Back</Button>
            <Button onClick={handleCommitWithFixes} loading={commit.isPending}>
              Import {validCount} + fixed rows
            </Button>
          </DialogFooter>
        </>
      )}

      {/* ── Step: Set balance (smart import had no balance column) ─────────── */}
      {step === "set-balance" && (
        <>
          <DialogBody className="space-y-5">
            <p className="text-sm text-muted-foreground">
              This CSV has no running balance column. Enter the current balance for this
              account so your totals stay accurate.
            </p>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Current balance</label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground text-sm">$</span>
                  <MoneyInput
                    placeholder="0.00"
                    value={manualBalance}
                    onValueChange={setManualBalance}
                    className="w-full rounded-md border border-border bg-background pl-7 pr-3 py-2 min-h-[40px] text-base md:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" autoFocus
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">As of</label>
                <Input type="date" min={EARLIEST_DATE} max={todayIso()} value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
              </div>
            </div>
            {balanceError && <p role="alert" className="text-sm text-destructive">{balanceError}</p>}
            {setBalance.error && (
              <p className="text-sm text-destructive">{(setBalance.error as Error).message}</p>
            )}
            {summary && (
              <p className="text-xs text-muted-foreground">
                {summary.imported} transaction{summary.imported !== 1 ? "s" : ""} imported
                {summary.skipped > 0 && `, ${summary.skipped} duplicate${summary.skipped !== 1 ? "s" : ""} skipped`}.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStep("done")} disabled={setBalance.isPending}>Skip</Button>
            <Button onClick={handleSaveBalance} disabled={setBalance.isPending}>
              {setBalance.isPending ? "Saving…" : "Save balance"}
            </Button>
          </DialogFooter>
        </>
      )}

      {/* ── Step: Done ────────────────────────────────────────────────────── */}
      {step === "done" && summary && (
        <>
          <DialogBody className="flex flex-col items-center gap-4 py-10">
            <CheckCircle size={48} className="text-success" />
            <div className="text-center space-y-1">
              <p className="text-lg font-semibold">Import complete</p>
              {summary.institution && summary.institution !== "Generic" && (
                <p className="text-sm text-muted-foreground">Detected: {summary.institution}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {summary.imported} transaction{summary.imported !== 1 ? "s" : ""} imported
                {summary.skipped > 0 && `, ${summary.skipped} duplicate${summary.skipped !== 1 ? "s" : ""} skipped`}.
              </p>
              {!!summary.incomeRecorded && (
                <p className="text-sm text-muted-foreground">
                  {summary.incomeRecorded} dividend{summary.incomeRecorded !== 1 ? "s" : ""} added to your holdings.
                </p>
              )}
              {!!(summary.holdingsCreated || summary.holdingsUpdated) && (
                <p className="text-sm text-muted-foreground">
                  Holdings: {summary.holdingsCreated ?? 0} added, {summary.holdingsUpdated ?? 0} updated.
                </p>
              )}
              {!!summary.holdingsKept && (
                <p className="text-sm text-muted-foreground">
                  {summary.holdingsKept} holding{summary.holdingsKept !== 1 ? "s" : ""} you keep by trades
                  {summary.holdingsKept !== 1 ? " were" : " was"} left as {summary.holdingsKept !== 1 ? "they are" : "it is"}.
                </p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={reset}>Import another file</Button>
            <Button onClick={handleClose}>Done</Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

// ── OFX / QFX review ──────────────────────────────────────────────────────────

/** An OFX file with nothing this account can take: no new cash rows, no
 *  positions, and no dividend for a holding kept by trades. Says why,
 *  rather than leaving the dialog empty. */
function NothingToImport({ preview, onBack }: { preview: OfxPreview; onBack: () => void }) {
  const incomeOnly = preview.statements.some(
    (s) => s.income_count > 0 && s.transaction_count === 0 && s.position_count === 0,
  );
  return (
    <>
      <DialogBody className="space-y-3 text-sm">
        <p className="font-medium">Nothing to import from this file</p>
        {incomeOnly ? (
          <p className="text-muted-foreground">
            It lists only dividends or reinvestments, with no positions and no cash movements. Paiso records a
            dividend on a holding you keep by trades. Your holdings here are kept by their share count, which
            the next statement with positions brings up to date.
          </p>
        ) : (
          <p className="text-muted-foreground">
            It has no transactions this account does not already have, and no positions to bring in.
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>Choose another file</Button>
      </DialogFooter>
    </>
  );
}

/** What an OFX or QFX file holds, before anything is written: which account
 *  in the file, how many rows are new, the dates, the balance, and anything
 *  about the file the person should know first. */
function OfxReview({
  preview, index, onIndex, accountName, error, importing, onBack, onImport,
}: {
  preview: OfxPreview;
  index: number;
  onIndex: (i: number) => void;
  accountName: string;
  error: string | null;
  importing: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  // A statement is worth offering when it has cash rows, positions, or
  // dividends to record.
  const withRows = preview.statements.filter(
    (s) => s.transaction_count > 0 || s.position_count > 0 || s.income_new > 0,
  );
  const stmt = withRows.find((s) => s.index === index) ?? withRows[0];
  if (!stmt) return <NothingToImport preview={preview} onBack={onBack} />;
  const day = (iso: string | null) => (iso ? formatDate(iso) : "");
  const label = (s: typeof stmt) =>
    `${OFX_ACCOUNT_TYPE[s.account_type ?? ""] ?? OFX_KIND[s.kind]}${s.account_last4 ? ` ending in ${s.account_last4}` : ""}`;
  const plural = (n: number) => (n !== 1 ? "s" : "");
  // Positions become holdings only in an investment account.
  const positions = stmt.kind === "investment" && stmt.fits_account ? stmt.position_count : 0;
  const nothing = stmt.new_count === 0 && positions === 0 && stmt.income_new === 0;
  const parts = [
    stmt.new_count > 0 ? `${stmt.new_count} transaction${plural(stmt.new_count)}` : "",
    positions > 0 ? `${positions} position${plural(positions)}` : "",
    stmt.income_new > 0 ? `${stmt.income_new} dividend${plural(stmt.income_new)}` : "",
  ].filter(Boolean);
  const importLabel = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0] ?? "";

  return (
    <>
      <DialogBody className="space-y-4">
        {withRows.length > 1 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              This file has {withRows.length} accounts. Choose the one to import.
            </p>
            {withRows.map((s) => (
              <label
                key={s.index}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-sm cursor-pointer",
                  s.index === stmt.index ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                )}
              >
                <input
                  type="radio"
                  name="ofx-statement"
                  checked={s.index === stmt.index}
                  onChange={() => onIndex(s.index)}
                />
                <span className="flex-1">{label(s)}</span>
                <span className="text-xs text-muted-foreground">
                  {s.position_count > 0
                    ? `${s.position_count} position${plural(s.position_count)}`
                    : `${s.new_count} new of ${s.transaction_count}`}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-1.5 text-sm">
          <p className="font-medium">
            {nothing ? "Nothing new in this file" : importLabel.replace(/^./, (c) => c.toUpperCase())}
            {stmt.date_from && stmt.date_to && (
              <span className="font-normal text-muted-foreground">
                {" "}from {day(stmt.date_from)} to {day(stmt.date_to)}
              </span>
            )}
          </p>
          {withRows.length === 1 && <p className="text-muted-foreground">{label(stmt)}</p>}
          {stmt.already_imported > 0 && (
            <p className="text-muted-foreground">
              {stmt.already_imported} already in {accountName}. Paiso skips {stmt.already_imported === 1 ? "it" : "them"}.
            </p>
          )}
          {stmt.balance != null && (
            <p className="text-muted-foreground">
              Statement balance {formatCurrencyFull(stmt.balance)}
              {stmt.balance_as_of ? ` on ${day(stmt.balance_as_of)}` : ""}
            </p>
          )}
        </div>

        {!stmt.fits_account && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <span>
              This is a {OFX_KIND[stmt.kind].toLowerCase()} statement, and {accountName} is a different
              kind of account. Check that you chose the right account before you import.
            </span>
          </div>
        )}
        {stmt.unreadable > 0 && (
          <p className="text-xs text-muted-foreground">
            {stmt.unreadable} row{plural(stmt.unreadable)} in the file {stmt.unreadable !== 1 ? "have" : "has"} no
            date or no amount. Paiso cannot import {stmt.unreadable !== 1 ? "them" : "it"}.
          </p>
        )}
        {positions > 0 && (
          <p className="text-xs text-muted-foreground">
            This file lists {positions} position{plural(positions)}. Paiso adds {positions !== 1 ? "them" : "it"} to
            your holdings, or updates the shares of a holding already there. A holding you keep by trades stays
            as it is. Buys, sales and dividends are not added as transactions: the positions already count them.
          </p>
        )}
        {stmt.kind === "investment" && stmt.position_count > 0 && !stmt.fits_account && (
          <p className="text-xs text-muted-foreground">
            Choose an investment account to bring in this file&apos;s positions as holdings.
          </p>
        )}

        {stmt.sample.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Most recent in the file</p>
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {stmt.sample.map((row, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{day(row.date)}</span>
                  <span className="flex-1 truncate">{row.description}</span>
                  <span className={cn("tabular-nums", row.amount >= 0 && "text-success")}>
                    {formatCurrencyFull(row.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>Choose another file</Button>
        <Button onClick={onImport} loading={importing} disabled={nothing}>
          {nothing ? "Nothing to import" : `Import ${importLabel}`}
        </Button>
      </DialogFooter>
    </>
  );
}

// ── CSV review ────────────────────────────────────────────────────────────────

/** What a CSV holds before anything is written: how many rows, how many are
 *  new, the ones Paiso cannot read and why, and the most recent rows. */
function CsvReview({
  preview, accountName, error, importing, onBack, onMapByHand, onImport,
}: {
  preview: BankImportPreview;
  accountName: string;
  error: string | null;
  importing: boolean;
  onBack: () => void;
  onMapByHand: () => void;
  onImport: () => void;
}) {
  const day = (iso: string | null) => (iso ? formatDate(iso) : "");
  const plural = (n: number) => (n !== 1 ? "s" : "");
  const already = preview.duplicate_count;
  const left = preview.unreadable.length;

  return (
    <>
      <DialogBody className="space-y-4">
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-1.5 text-sm">
          <p className="font-medium">
            {preview.new_count === 0
              ? "Nothing new in this file"
              : `${preview.new_count} new transaction${plural(preview.new_count)}`}
            {preview.date_from && preview.date_to && (
              <span className="font-normal text-muted-foreground">
                {" "}from {day(preview.date_from)} to {day(preview.date_to)}
              </span>
            )}
          </p>
          <p className="text-muted-foreground">
            {preview.row_count} row{plural(preview.row_count)} in the file
            {preview.institution !== "Generic" ? `, read as a ${preview.institution} statement` : ""}.
          </p>
          {already > 0 && (
            <p className="text-muted-foreground">
              {already} already in {accountName}. Paiso skips {already === 1 ? "it" : "them"}.
            </p>
          )}
        </div>

        {left > 0 && (
          <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
            <p className="flex items-start gap-2 text-sm font-medium">
              <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
              {left} row{plural(left)} cannot be imported
            </p>
            <ul className="max-h-40 space-y-1.5 overflow-y-auto text-xs">
              {preview.unreadable.map((r) => (
                <li key={r.line}>
                  <span className="font-medium">Line {r.line}:</span>{" "}
                  <span className="text-muted-foreground">{r.reason}</span>
                  <span className="block truncate text-muted-foreground/80">{r.values.join(", ")}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Fix {left === 1 ? "it" : "them"} in the file and import it again, or import the rest now.
            </p>
          </div>
        )}

        {preview.sample.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Most recent in the file</p>
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {preview.sample.map((row, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{day(row.date)}</span>
                  <span className="flex-1 truncate">{row.description}</span>
                  <span className={cn("tabular-nums", row.amount >= 0 && "text-success")}>
                    {formatCurrencyFull(row.amount)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <button type="button" onClick={onMapByHand} className="text-xs text-primary hover:underline">
          Columns look wrong? Match them yourself
        </button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>Choose another file</Button>
        <Button onClick={onImport} loading={importing} disabled={preview.new_count === 0}>
          {preview.new_count === 0
            ? "Nothing to import"
            : `Import ${preview.new_count} transaction${plural(preview.new_count)}`}
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Malformed row inline editor ───────────────────────────────────────────────

interface MalformedRowEditorProps {
  row: InvalidCsvRow;
  columnMap: Record<string, string>;
  debitCol: string;
  creditCol: string;
  onCorrect: (field: string, value: string) => void;
}

function MalformedRowEditor({ row, columnMap, debitCol, creditCol, onCorrect }: MalformedRowEditorProps) {
  const errorFields = Object.keys(row.errors);

  const colToLabel: Record<string, string> = {};
  for (const { key, label } of CANONICAL) {
    const col = columnMap[key];
    if (col) colToLabel[col] = label;
  }

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
      <p className="text-xs font-medium text-destructive">Row {row.row_index + 1}</p>

      <div className="flex flex-wrap gap-2">
        {Object.entries(row.raw).map(([col, val]) => (
          <span key={col} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{colToLabel[col] ?? col}:</span>{" "}
            {val || <em className="opacity-50">empty</em>}
          </span>
        ))}
      </div>

      <div className="space-y-2">
        {errorFields.map((field) => {
          const label = CANONICAL.find((c) => c.key === field)?.label ?? field;
          const rawCol = field === "debit" ? debitCol : field === "credit" ? creditCol : columnMap[field];
          const currentValue = row.corrected?.[field] ?? (rawCol ? row.raw[rawCol] : "");
          return (
            <div key={field} className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-destructive">{label}</label>
                <span className="text-xs text-muted-foreground">{row.errors[field]}</span>
              </div>
              <Input
                className="h-7 text-xs border-destructive/50 focus:border-destructive"
                value={currentValue}
                onChange={(e) => onCorrect(field, e.target.value)}
                placeholder={field === "date_posted" ? "YYYY-MM-DD" : field === "amount" ? "-42.50" : ""}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
