// dashboard-catalog: not offered, one property's value, shown on that property's card.
import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { toastError } from "@/components/ui/toast";
import { UPLOAD_LIMITS, tooLarge } from "@/lib/uploadLimits";
import { api, getAccessToken } from "@/lib/api";
import {
  Plus,
  Home,
  Building2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  TrendingUp,
  Camera,
  AlertTriangle,
  EyeOff,
  Pencil,
} from "@/lib/icons";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { useAssets, useCreateAsset, useDeleteAsset, useUpdateAsset } from "@/hooks/useAssets";
import { useAccounts, useCreateMortgage } from "@/hooks/useAccounts";
import type { Account } from "@/types";
import type { Asset } from "@/hooks/useAssets";
import { computePayoffInfo, monthlyPrincipalAndInterest } from "@/lib/loanPayoff";
import { formatCurrency, cn } from "@/lib/utils";
import { EARLIEST_DATE, parseLocalDate, todayIso } from "@/lib/validation";
import { niceMoneyAxis } from "@/lib/chartTicks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PropertyMetadata {
  rental_income: number;
  rental_income_period: "monthly" | "annual";
  rental_expenses: number;
  rental_expenses_period: "monthly" | "annual";
  zillow_url: string;
}

function getMetadata(asset: Asset): PropertyMetadata {
  const m = (asset.metadata_json as Record<string, unknown> | null) ?? {};
  return {
    rental_income: Number(m.rental_income ?? 0),
    rental_income_period: (m.rental_income_period as "monthly" | "annual") || "monthly",
    rental_expenses: Number(m.rental_expenses ?? 0),
    rental_expenses_period: (m.rental_expenses_period as "monthly" | "annual") || "monthly",
    zillow_url: (m.zillow_url as string) || "",
  };
}

function toMonthly(value: number, period: "monthly" | "annual"): number {
  return period === "annual" ? value / 12 : value;
}

function formatPayoffDate(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

// ---------------------------------------------------------------------------
// AddPropertyDrawer
// ---------------------------------------------------------------------------

interface AddFormState {
  name: string;
  category: string;
  value: string;
  acquired_value: string;
  acquired_at: string;
  ownership_pct: string;
  rental_income: string;
  rental_income_period: "monthly" | "annual";
  rental_expenses: string;
  rental_expenses_period: "monthly" | "annual";
  zillow_url: string;
  principal: string;
  rate: string;
  term: string;
  origination: string;
}

const EMPTY_ADD: AddFormState = {
  name: "", category: "primary_home", value: "", acquired_value: "",
  acquired_at: "", ownership_pct: "100", rental_income: "",
  rental_income_period: "monthly", rental_expenses: "",
  rental_expenses_period: "monthly", zillow_url: "",
  principal: "", rate: "", term: "360", origination: "",
};

/** Loan and mortgage accounts not yet behind a property: the ones Add
 *  Property can use instead of creating a second account for the same debt. */
function useUnlinkedMortgages(): Account[] {
  const { data: accounts = [] } = useAccounts();
  return accounts.filter(
    (a) => (a.account_type === "mortgage" || a.account_type === "loan") && a.linked_asset_id == null,
  );
}

/** Which mortgage the new property uses: an existing account's id, or "new". */
type MortgageChoice = number | "new";

function AddPropertyDrawer({
  open,
  onClose,
  initialType = null,
}: {
  open: boolean;
  onClose: () => void;
  initialType?: "fully_owned" | "mortgage" | null;
}) {
  const create = useCreateAsset();
  const createMortgage = useCreateMortgage();
  const unlinked = useUnlinkedMortgages();

  const [ownershipType, setOwnershipType] = useState<"fully_owned" | "mortgage" | null>(initialType);
  const [mortgageChoice, setMortgageChoice] = useState<MortgageChoice | null>(null);
  const [form, setForm] = useState<AddFormState>(EMPTY_ADD);
  const [mortgageAccountName, setMortgageAccountName] = useState("");
  const [mortgageInstitution, setMortgageInstitution] = useState("");
  const [monthlyEscrow, setMonthlyEscrow] = useState("");
  const [extraPrincipal, setExtraPrincipal] = useState("");
  const [descriptionPattern, setDescriptionPattern] = useState("");

  const set = <K extends keyof AddFormState>(k: K, v: AddFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isRental = form.category === "rental";
  // Worked out as the user types the amount, rate and term: these used to be
  // two boxes the user filled in by hand, which were never saved, so the
  // total read $0.00 while the saved card showed the real payment.
  const monthlyPI = monthlyPrincipalAndInterest(
    parseFloat(form.principal), parseFloat(form.rate), parseInt(form.term, 10),
  );
  const totalMonthly =
    monthlyPI + (parseFloat(monthlyEscrow) || 0) + (parseFloat(extraPrincipal) || 0);

  useEffect(() => {
    if (open && initialType) setOwnershipType(initialType);
  }, [open, initialType]);

  // An existing mortgage comes first: a second, hand-entered one for the same
  // home is how the debt came to be counted twice.
  const choice: MortgageChoice = mortgageChoice ?? (unlinked[0]?.id ?? "new");
  const linkedAccount = typeof choice === "number" ? unlinked.find((a) => a.id === choice) ?? null : null;

  function chooseMortgage(next: MortgageChoice) {
    setMortgageChoice(next);
    const acct = typeof next === "number" ? unlinked.find((a) => a.id === next) : null;
    const l = acct?.liability;
    if (!l) return;
    // Fill what the bank already told us, without overwriting what was typed.
    setForm((f) => ({
      ...f,
      principal: f.principal || (l.origination_principal != null ? String(l.origination_principal) : ""),
      rate: f.rate || (l.apr_pct != null ? String(l.apr_pct) : ""),
      term: l.term_months != null && f.term === EMPTY_ADD.term ? String(l.term_months) : f.term,
      origination: f.origination || (l.origination_date ?? ""),
    }));
  }

  useEffect(() => {
    if (ownershipType === "mortgage" && mortgageChoice == null && unlinked[0]) chooseMortgage(unlinked[0].id);
  }, [ownershipType, unlinked.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    setOwnershipType(null);
    setMortgageChoice(null);
    setForm(EMPTY_ADD);
    setMortgageAccountName(""); setMortgageInstitution("");
    setMonthlyEscrow("");
    setExtraPrincipal(""); setDescriptionPattern("");
  }

  function handleClose() { reset(); onClose(); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    if (ownershipType === "mortgage") {
      await createMortgage.mutateAsync({
        account_id: linkedAccount?.id ?? null,
        display_name: mortgageAccountName || form.name,
        institution_name: mortgageInstitution || undefined,
        description_pattern: descriptionPattern.trim() || null,
        property_address: form.name,
        category: form.category,
        current_value: form.value ? Number(form.value) : null,
        acquired_value: form.acquired_value ? Number(form.acquired_value) : null,
        acquired_at: form.acquired_at || null,
        ownership_pct: form.ownership_pct ? Number(form.ownership_pct) : 100,
        zillow_url: form.zillow_url || null,
        principal: Number(form.principal),
        rate_apr: Number(form.rate),
        term_months: Number(form.term),
        origination: form.origination,
        extra_principal_monthly: parseFloat(extraPrincipal) || 0,
        insurance_monthly: parseFloat(monthlyEscrow) || 0,
        property_tax_monthly: 0,
      });
      handleClose();
      return;
    }

    const metadata: Record<string, unknown> = { zillow_url: form.zillow_url };
    if (isRental) {
      metadata.rental_income = form.rental_income ? Number(form.rental_income) : 0;
      metadata.rental_income_period = form.rental_income_period;
      metadata.rental_expenses = form.rental_expenses ? Number(form.rental_expenses) : 0;
      metadata.rental_expenses_period = form.rental_expenses_period;
    }
    await create.mutateAsync({
      category: form.category,
      name: form.name,
      current_value: form.value ? Number(form.value) : undefined,
      acquired_value: form.acquired_value ? Number(form.acquired_value) : undefined,
      acquired_at: form.acquired_at || undefined,
      ownership_pct: form.ownership_pct ? Number(form.ownership_pct) : 100,
      metadata_json: metadata,
    });
    handleClose();
  }

  const isPending = create.isPending || createMortgage.isPending;

  const labelCls = "text-xs font-medium text-muted-foreground uppercase tracking-wide";
  const inputCls = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60";

  return (
    <SideDrawer open={open} onClose={handleClose} title="Add property">
      <div className="px-5 py-5 space-y-5">
        {/* Step 1 — ownership type */}
        {!ownershipType ? (
          <>
            <p className="text-sm text-muted-foreground">How do you own this property?</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setOwnershipType("fully_owned")}
                className="flex flex-col items-center gap-3 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 px-4 py-6 transition-all text-center"
              >
                <Home size={28} className="text-primary" />
                <div>
                  <p className="font-medium text-sm">Fully Owned</p>
                  <p className="text-xs text-muted-foreground mt-0.5">No mortgage or paid off</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setOwnershipType("mortgage")}
                className="flex flex-col items-center gap-3 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 px-4 py-6 transition-all text-center"
              >
                <Building2 size={28} className="text-primary" />
                <div>
                  <p className="font-medium text-sm">Mortgage</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Active mortgage loan</p>
                </div>
              </button>
            </div>
          </>
        ) : (
          /* Step 2 — form */
          <form onSubmit={submit} className="space-y-4">
            <button
              type="button"
              onClick={() => setOwnershipType(null)}
              className="text-xs text-primary hover:underline"
            >
              ← Back
            </button>

            {/* Common property fields */}
            <div className="space-y-1.5">
              <label className={labelCls}>Property Address / Name</label>
              <input required type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>Category</label>
                <select value={form.category} onChange={(e) => set("category", e.target.value)} className={inputCls}>
                  <option value="primary_home">Primary Home</option>
                  <option value="rental">Rental Property</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>Acquired Date</label>
                <input type="date" min={EARLIEST_DATE} max={todayIso()} value={form.acquired_at} onChange={(e) => set("acquired_at", e.target.value)} className={inputCls} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>Current Estimated Value ($)</label>
                <input type="number" min="0.01" step="0.01" value={form.value} onChange={(e) => set("value", e.target.value)} className={inputCls} />
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>Purchase Price ($)</label>
                <input type="number" min="0.01" step="0.01" value={form.acquired_value} onChange={(e) => set("acquired_value", e.target.value)} className={inputCls} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelCls}>Ownership %</label>
                <input type="number" min="0.01" max="100" step="0.01" value={form.ownership_pct} onChange={(e) => set("ownership_pct", e.target.value)} className={inputCls} />
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>Zillow URL <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
                <input type="url" value={form.zillow_url} onChange={(e) => set("zillow_url", e.target.value)} placeholder="https://www.zillow.com/..." className={inputCls} />
              </div>
            </div>

            {isRental && (
              <div className="space-y-3 border-t border-border pt-3">
                <p className={labelCls}>Rental Details</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={labelCls}>Rental Income ($)</label>
                    <input type="number" value={form.rental_income} onChange={(e) => set("rental_income", e.target.value)} className={inputCls} />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>Period</label>
                    <select value={form.rental_income_period} onChange={(e) => set("rental_income_period", e.target.value as "monthly" | "annual")} className={inputCls}>
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={labelCls}>Rental Expenses ($)</label>
                    <input type="number" value={form.rental_expenses} onChange={(e) => set("rental_expenses", e.target.value)} className={inputCls} />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>Period</label>
                    <select value={form.rental_expenses_period} onChange={(e) => set("rental_expenses_period", e.target.value as "monthly" | "annual")} className={inputCls}>
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Mortgage extra fields */}
            {ownershipType === "mortgage" && (
              <>
                {unlinked.length > 0 && (
                  <fieldset className="space-y-2 border-t border-border pt-3">
                    <legend className={labelCls}>Which mortgage pays for it?</legend>
                    {unlinked.map((a) => (
                      <label key={a.id} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                        <input type="radio" name="mortgage" checked={choice === a.id} onChange={() => chooseMortgage(a.id)} className="mt-1 accent-primary" />
                        <span className="text-sm">
                          <span className="font-medium">Use {a.display_name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {[a.institution_name, a.current_balance != null ? `${formatCurrency(Math.abs(a.current_balance))} owed` : null]
                              .filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      </label>
                    ))}
                    <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input type="radio" name="mortgage" checked={choice === "new"} onChange={() => chooseMortgage("new")} className="mt-1 accent-primary" />
                      <span className="text-sm">
                        <span className="font-medium">A mortgage not listed here</span>
                        <span className="block text-xs text-muted-foreground">Paiso adds it as a new account.</span>
                      </span>
                    </label>
                    {choice === "new" && (
                      <p role="alert" className="text-xs text-warning">
                        If this home's mortgage is one of the accounts above, choose it instead. Adding it again counts the debt twice.
                      </p>
                    )}
                    {linkedAccount && (
                      <p className="text-xs text-muted-foreground">
                        The loan balance comes from {linkedAccount.display_name} and stays up to date with it. The terms below set the payoff projection.
                      </p>
                    )}
                  </fieldset>
                )}

                {!linkedAccount && (
                <div className="space-y-3 border-t border-border pt-3">
                  <p className={labelCls}>Mortgage Account</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className={labelCls}>Account Name <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
                      <input type="text" value={mortgageAccountName} onChange={(e) => setMortgageAccountName(e.target.value)} placeholder="e.g. Chase Mortgage" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                      <label className={labelCls}>Lender / Institution</label>
                      <input type="text" value={mortgageInstitution} onChange={(e) => setMortgageInstitution(e.target.value)} placeholder="e.g. Chase Bank" className={inputCls} />
                    </div>
                  </div>
                </div>
                )}

                <div className="space-y-3 border-t border-border pt-3">
                  <p className={labelCls}>Loan Details</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className={labelCls}>Total Loan Amount ($)</label>
                      <input required type="number" min="0.01" step="0.01" value={form.principal} onChange={(e) => set("principal", e.target.value)} className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                      <label className={labelCls}>Loan Start Date</label>
                      <input required type="date" min={EARLIEST_DATE} value={form.origination} onChange={(e) => set("origination", e.target.value)} className={inputCls} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className={labelCls}>Interest Rate (APR %)</label>
                      <input required type="number" min="0" max="100" step="0.001" value={form.rate} onChange={(e) => set("rate", e.target.value)} placeholder="6.500" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                      <label className={labelCls}>Term (months)</label>
                      <input required type="number" min="1" max="600" step="1" value={form.term} onChange={(e) => set("term", e.target.value)} className={inputCls} />
                    </div>
                  </div>
                  <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Principal &amp; Interest</span>
                    <span className="text-sm">
                      ${monthlyPI.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className={labelCls}>Monthly Escrow ($)</label>
                      <input type="number" min="0" step="0.01" value={monthlyEscrow} onChange={(e) => setMonthlyEscrow(e.target.value)} placeholder="0.00" className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                      <label className={labelCls}>Extra Monthly Principal ($) <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
                      <input type="number" min="0" step="0.01" value={extraPrincipal} onChange={(e) => setExtraPrincipal(e.target.value)} placeholder="0.00" className={inputCls} />
                    </div>
                  </div>
                  <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Total Monthly Payment</span>
                    <span className="text-sm font-semibold">
                      ${totalMonthly.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {!linkedAccount && (
                <div className="space-y-2 border-t border-border pt-3">
                  <p className={labelCls}>Transaction Matching</p>
                  <p className="text-xs text-muted-foreground/70">
                    Optional text matched against checking transactions to show mortgage payments in the Mortgage tab.
                  </p>
                  <div className="space-y-1.5">
                    <label className={labelCls}>ACH Description Pattern <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
                    <input type="text" value={descriptionPattern} onChange={(e) => setDescriptionPattern(e.target.value)} placeholder="e.g. JPMORGAN CHASE" className={inputCls} />
                  </div>
                </div>
                )}
              </>
            )}

            {(create.error || createMortgage.error) && (
              <p className="text-sm text-destructive">
                {((create.error || createMortgage.error) as Error).message}
              </p>
            )}

            <Button type="submit" loading={isPending} className="w-full">
              {ownershipType !== "mortgage" ? "Add property" : linkedAccount ? "Add property" : "Add property and mortgage"}
            </Button>
          </form>
        )}
      </div>
    </SideDrawer>
  );
}

// ---------------------------------------------------------------------------
// EditPropertyDrawer
// ---------------------------------------------------------------------------

interface EditFormState {
  name: string;
  current_value: string;
  acquired_value: string;
  acquired_at: string;
  principal: string;
  rate: string;
  term: string;
  origination: string;
  ownership_pct: string;
  rental_income: string;
  rental_income_period: "monthly" | "annual";
  rental_expenses: string;
  rental_expenses_period: "monthly" | "annual";
  zillow_url: string;
  balance_override: string;
  balance_override_date: string;
  extra_principal: string;
  insurance_monthly: string;
  property_tax_monthly: string;
  exclude_from_net_worth: boolean;
}

function EditPropertyDrawer({
  asset,
  onClose,
}: {
  asset: Asset | null;
  onClose: () => void;
}) {
  const update = useUpdateAsset();
  const deleteAsset = useDeleteAsset();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data: accounts = [] } = useAccounts();
  const linkedAccounts = asset ? accounts.filter((a) => a.linked_asset_id === asset.id) : [];
  const ownAccounts = linkedAccounts;
  const [deleteAccounts, setDeleteAccounts] = useState(true);

  const meta = asset ? getMetadata(asset) : null;
  const isRental = asset?.category === "rental";

  const [form, setForm] = useState<EditFormState>({
    name: "",
    current_value: "",
    acquired_value: "",
    acquired_at: "",
    principal: "",
    rate: "",
    term: "",
    origination: "",
    ownership_pct: "100",
    rental_income: "",
    rental_income_period: "monthly",
    rental_expenses: "",
    rental_expenses_period: "monthly",
    zillow_url: "",
    balance_override: "",
    balance_override_date: todayIso(),
    extra_principal: "",
    insurance_monthly: "",
    property_tax_monthly: "",
    exclude_from_net_worth: false,
  });

  const assetId = asset?.id;
  useEffect(() => {
    if (asset && meta) {
      const existingMeta = (asset.metadata_json as Record<string, unknown> | null) ?? {};
      setForm({
        name: asset.name,
        current_value: asset.current_value != null ? String(asset.current_value) : "",
        acquired_value: asset.acquired_value != null ? String(asset.acquired_value) : "",
        acquired_at: asset.acquired_at?.slice(0, 10) ?? "",
        principal: asset.loan ? String(asset.loan.principal) : "",
        rate: asset.loan ? String(asset.loan.rate_apr) : "",
        term: asset.loan ? String(asset.loan.term_months) : "",
        origination: asset.loan?.origination?.slice(0, 10) ?? "",
        ownership_pct: String(asset.ownership_pct ?? 100),
        rental_income: meta.rental_income ? String(meta.rental_income) : "",
        rental_income_period: meta.rental_income_period,
        rental_expenses: meta.rental_expenses ? String(meta.rental_expenses) : "",
        rental_expenses_period: meta.rental_expenses_period,
        zillow_url: meta.zillow_url,
        balance_override: asset.loan?.balance_override != null ? String(asset.loan.balance_override) : "",
        balance_override_date: asset.loan?.balance_override_date ?? todayIso(),
        extra_principal: asset.loan?.extra_principal_monthly ? String(asset.loan.extra_principal_monthly) : "",
        insurance_monthly: asset.loan?.insurance_monthly ? String(asset.loan.insurance_monthly) : "",
        property_tax_monthly: asset.loan?.property_tax_monthly ? String(asset.loan.property_tax_monthly) : "",
        exclude_from_net_worth: !!existingMeta.exclude_from_net_worth,
      });
      setConfirmDelete(false);
      setDeleteAccounts(true);
    }
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof EditFormState>(k: K, v: EditFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!asset) return;

    const existingMeta = (asset.metadata_json as Record<string, unknown> | null) ?? {};
    const newMeta: Record<string, unknown> = { ...existingMeta, zillow_url: form.zillow_url };
    delete newMeta.loan_balance_override;
    if (form.exclude_from_net_worth) newMeta.exclude_from_net_worth = true;
    else delete newMeta.exclude_from_net_worth;

    if (isRental) {
      newMeta.rental_income = form.rental_income ? Number(form.rental_income) : 0;
      newMeta.rental_income_period = form.rental_income_period;
      newMeta.rental_expenses = form.rental_expenses ? Number(form.rental_expenses) : 0;
      newMeta.rental_expenses_period = form.rental_expenses_period;
    }

    const loanPayload = asset.loan ? {
      principal: Number(form.principal),
      rate_apr: Number(form.rate),
      term_months: Number(form.term),
      origination: form.origination,
      extra_principal_monthly: form.extra_principal ? Number(form.extra_principal) : 0,
      insurance_monthly: form.insurance_monthly ? Number(form.insurance_monthly) : 0,
      property_tax_monthly: form.property_tax_monthly ? Number(form.property_tax_monthly) : 0,
      ...(form.balance_override
        ? { balance_override: Number(form.balance_override), balance_override_date: form.balance_override_date || undefined }
        : { clear_override: true }),
    } : undefined;

    await update.mutateAsync({
      id: asset.id,
      name: form.name,
      current_value: form.current_value ? Number(form.current_value) : undefined,
      acquired_value: form.acquired_value ? Number(form.acquired_value) : undefined,
      acquired_at: form.acquired_at || undefined,
      ownership_pct: form.ownership_pct ? Number(form.ownership_pct) : 100,
      metadata_json: newMeta,
      loan: loanPayload,
    });
    onClose();
  }

  async function handleDelete() {
    if (!asset) return;
    await deleteAsset.mutateAsync({ id: asset.id, deleteAccounts: deleteAccounts && ownAccounts.length > 0 });
    onClose();
  }

  // Dynamic payoff preview — recomputes live as form.extra_principal / balance_override change
  const effectiveBalanceOverride = form.balance_override
    ? Number(form.balance_override)
    : (asset?.loan?.balance_override ?? null);
  const effectiveOverrideDate = form.balance_override
    ? form.balance_override_date
    : (asset?.loan?.balance_override_date ?? null);

  // The terms as edited, so the payoff preview moves with them.
  const editedTerms = asset?.loan && Number(form.principal) > 0 && Number(form.term) >= 1 && form.origination
    ? { principal: Number(form.principal), rate_apr: Number(form.rate) || 0, term_months: Number(form.term), origination: form.origination }
    : asset?.loan ?? null;
  const previewPayoff = editedTerms
    ? computePayoffInfo(editedTerms, parseFloat(form.extra_principal) || 0, effectiveBalanceOverride, effectiveOverrideDate)
    : null;
  const baselinePayoff = editedTerms
    ? computePayoffInfo(editedTerms, 0, effectiveBalanceOverride, effectiveOverrideDate)
    : null;
  const editedPI = editedTerms
    ? monthlyPrincipalAndInterest(editedTerms.principal, editedTerms.rate_apr, editedTerms.term_months)
    : 0;
  const monthsReduced = (baselinePayoff && previewPayoff)
    ? Math.max(0, baselinePayoff.totalMonths - previewPayoff.totalMonths)
    : 0;
  const payoffColorCls =
    monthsReduced >= 24 ? "text-success" :
    monthsReduced >= 12 ? "text-warning" :
    "text-foreground";

  const labelCls = "text-xs font-medium text-muted-foreground uppercase tracking-wide";
  const inputCls = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60";

  return (
    <SideDrawer open={asset != null} onClose={onClose} title={asset?.name ?? "Edit property"}>
      {asset && (
        <form onSubmit={handleSave} className="px-5 py-5 space-y-4">

          <div className="space-y-1.5">
            <label className={labelCls}>Property Name</label>
            <input required type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Current Estimated Value ($)</label>
              <input type="number" min="0.01" step="0.01" value={form.current_value} onChange={(e) => set("current_value", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Ownership %</label>
              <input type="number" min="0.01" max="100" step="0.01" value={form.ownership_pct} onChange={(e) => set("ownership_pct", e.target.value)} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Purchase Price ($)</label>
              <input type="number" min="0.01" step="0.01" value={form.acquired_value} onChange={(e) => set("acquired_value", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Acquired Date</label>
              <input type="date" min={EARLIEST_DATE} max={todayIso()} value={form.acquired_at} onChange={(e) => set("acquired_at", e.target.value)} className={inputCls} />
            </div>
          </div>

          {isRental && (
            <div className="space-y-3 border-t border-border pt-3">
              <p className={labelCls}>Rental Details</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>Rental Income ($)</label>
                  <input type="number" value={form.rental_income} onChange={(e) => set("rental_income", e.target.value)} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Period</label>
                  <select value={form.rental_income_period} onChange={(e) => set("rental_income_period", e.target.value as "monthly" | "annual")} className={inputCls}>
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>Rental Expenses ($)</label>
                  <input type="number" value={form.rental_expenses} onChange={(e) => set("rental_expenses", e.target.value)} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Period</label>
                  <select value={form.rental_expenses_period} onChange={(e) => set("rental_expenses_period", e.target.value as "monthly" | "annual")} className={inputCls}>
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className={labelCls}>Zillow URL <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
            <input type="url" value={form.zillow_url} onChange={(e) => set("zillow_url", e.target.value)} placeholder="https://www.zillow.com/..." className={inputCls} />
          </div>

          {asset.loan && (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <p className={labelCls}>Loan Details</p>
                {previewPayoff && (
                  <span className="text-xs text-muted-foreground">
                    Est. payoff <span className={cn("font-medium", payoffColorCls)}>{previewPayoff.payoffDateStr}</span>
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>Total Loan Amount ($)</label>
                  <input required type="number" min="0.01" step="0.01" value={form.principal} onChange={(e) => set("principal", e.target.value)} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Loan Start Date</label>
                  <input required type="date" min={EARLIEST_DATE} value={form.origination} onChange={(e) => set("origination", e.target.value)} className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>Interest Rate (APR %)</label>
                  <input required type="number" min="0" max="100" step="0.001" value={form.rate} onChange={(e) => set("rate", e.target.value)} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Term (months)</label>
                  <input required type="number" min="1" max="600" step="1" value={form.term} onChange={(e) => set("term", e.target.value)} className={inputCls} />
                </div>
              </div>
              <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Principal &amp; Interest</span>
                <span className="text-sm">
                  ${editedPI.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Enter the current balance to anchor the payoff projection from today. Leave blank to use the schedule-calculated value.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>Current Principal Balance ($)</label>
                  <input type="number" step="0.01" placeholder="e.g. 186876" min="0" value={form.balance_override} onChange={(e) => set("balance_override", e.target.value)} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Balance As-Of Date</label>
                  <input type="date" min={EARLIEST_DATE} max={todayIso()} value={form.balance_override_date} onChange={(e) => set("balance_override_date", e.target.value)} className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label className={labelCls}>Extra Principal ($/mo)</label>
                  <input type="number" step="0.01" placeholder="0" min="0" value={form.extra_principal} onChange={(e) => set("extra_principal", e.target.value)} className={inputCls} />
                  {asset.loan?.extra_principal_source === "payments" && (
                    <p className="text-[11px] text-muted-foreground">Your average over the last six months of extra payments.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Insurance ($/mo)</label>
                  <input type="number" step="0.01" placeholder="0" min="0" value={form.insurance_monthly} onChange={(e) => set("insurance_monthly", e.target.value)} className={inputCls} />
                </div>
                <div className="space-y-1.5">
                  <label className={labelCls}>Property Tax ($/mo)</label>
                  <input type="number" step="0.01" placeholder="0" min="0" value={form.property_tax_monthly} onChange={(e) => set("property_tax_monthly", e.target.value)} className={inputCls} />
                </div>
              </div>
              {asset.loan?.escrow_source === "payments" && asset.loan.escrow_monthly != null
                && !Number(form.insurance_monthly) && !Number(form.property_tax_monthly) && (
                <p className="text-xs text-muted-foreground">
                  Escrow of {formatCurrency(asset.loan.escrow_monthly)} a month comes from your payments. Type insurance
                  and property tax to replace it.
                </p>
              )}
              {form.balance_override && (
                <p className="text-xs text-muted-foreground">
                  Monthly P+I will be recalculated from the balance above.
                </p>
              )}
            </div>
          )}

          {/* Exclude from net worth */}
          <div className="border-t border-border pt-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.exclude_from_net_worth}
                onChange={(e) => set("exclude_from_net_worth", e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
              />
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <EyeOff size={13} className="text-muted-foreground" />
                  Exclude from net worth
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">This property will not be counted in your total net worth.</p>
              </div>
            </label>
          </div>

          {update.error && (
            <p className="text-sm text-destructive">{(update.error as Error).message}</p>
          )}

          <Button type="submit" loading={update.isPending} className="w-full">
            Save changes
          </Button>

          <hr className="border-border" />

          {/* Delete */}
          {confirmDelete ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive text-center">
                This permanently deletes the property{asset.loan ? " and its loan" : ""}.
              </p>
              {ownAccounts.length > 0 && (
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                  <input type="checkbox" checked={deleteAccounts} onChange={(e) => setDeleteAccounts(e.target.checked)} className="mt-0.5 accent-primary" />
                  <span>
                    Also delete {ownAccounts.map((a) => a.display_name).join(", ")} and its transactions.
                  </span>
                </label>
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={handleDelete}
                  loading={deleteAsset.isPending}
                >
                  <AlertTriangle size={13} />
                  Confirm delete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
            >
              Delete property
            </button>
          )}
        </form>
      )}
    </SideDrawer>
  );
}

// ---------------------------------------------------------------------------
// ValueTrendChart
// ---------------------------------------------------------------------------

interface TrendPoint {
  year: string;
  value: number;
}

function ValueTrendChart({ asset }: { asset: Asset }) {
  if (!asset.acquired_at || asset.acquired_value == null || asset.current_value == null) {
    return null;
  }

  const acquiredYear = parseLocalDate(asset.acquired_at).getFullYear().toString();
  const todayYear = new Date().getFullYear().toString();

  const data: TrendPoint[] = [
    { year: acquiredYear, value: asset.acquired_value },
    { year: todayYear, value: asset.current_value },
  ];

  const gained = asset.current_value >= asset.acquired_value;
  const yAxis = niceMoneyAxis(data.map((p) => p.value), { target: 3 });

  return (
    <div className="px-4 pb-3">
      <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
        <TrendingUp size={11} />
        Value Trend
      </p>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={yAxis?.tickFormatter}
            ticks={yAxis?.ticks}
            domain={yAxis?.domain}
            width={48}
          />
          <Tooltip formatter={(v: number) => [formatCurrency(v), "Value"]} contentStyle={{ fontSize: 12 }} />
          {/* `--color-success` / `--color-destructive` were never defined, so
              this always painted the fallback hex. Naming it directly is what
              every other gain/loss line in the app already does. */}
          <Line
            type="monotone"
            dataKey="value"
            dot={{ r: 4 }}
            strokeWidth={2}
            stroke={gained ? "#22c55e" : "#ef4444"}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PropertyCard
// ---------------------------------------------------------------------------

function usePropertyThumbnail(assetId: number, hasThumbnailSource: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hasThumbnailSource) { setUrl(null); return; }
    const token = getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    fetch(`/api/assets/${assetId}/thumbnail`, { headers, credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.url) setUrl(data.url); })
      .catch(() => null);
  }, [assetId, hasThumbnailSource]);
  return [url, setUrl] as const;
}

function PropertyCard({
  asset,
  onSelect,
}: {
  asset: Asset;
  onSelect: () => void;
}) {
  const [showSchedule, setShowSchedule] = useState(false);
  const update = useUpdateAsset();

  const [editingValue, setEditingValue] = useState(false);
  const [newValue, setNewValue] = useState(String(asset.current_value ?? ""));

  const isRental = asset.category === "rental";
  const ownershipPct = asset.ownership_pct ?? 100;
  const meta = getMetadata(asset);

  // A property can be saved without a value. `current_value ?? 0` then
  // made equity `0 - balance`, so a brand-new property reported the whole
  // mortgage as negative equity — a number that looks authoritative and is
  // simply wrong. Equity is unknowable without a value, so say so.
  const isValued = asset.current_value != null;
  const currentValue = asset.current_value ?? 0;
  const loanBalance = asset.loan?.current_balance ?? 0;
  const equity = isValued ? currentValue - loanBalance : null;
  const equityPct =
    isValued && currentValue > 0 ? ((equity as number) / currentValue) * 100 : null;

  const monthlyIncome = toMonthly(meta.rental_income, meta.rental_income_period);
  const monthlyExpenses = toMonthly(meta.rental_expenses, meta.rental_expenses_period);
  const adjIncome = monthlyIncome * (ownershipPct / 100);
  const adjExpenses = monthlyExpenses * (ownershipPct / 100);
  const myShare = currentValue * (ownershipPct / 100);

  const schedule = asset.loan?.schedule ?? [];
  // The next payment due: the schedule now keeps the months before today.
  // Its principal includes any extra, which is not part of the P&I.
  const nextRow = schedule.find((r) => r.payment_date >= new Date().toISOString().slice(0, 10)) ?? schedule[0];
  const monthlyPI = nextRow
    ? (nextRow.principal ?? 0) + (nextRow.interest ?? 0) - (asset.loan?.extra_principal_monthly ?? 0)
    : 0;
  const monthlyEscrow = asset.loan
    ? (asset.loan.insurance_monthly + asset.loan.property_tax_monthly) || (asset.loan.escrow_monthly ?? 0)
    : 0;
  const payoffDate = schedule.length > 0 ? schedule[schedule.length - 1].payment_date : null;

  async function saveValue() {
    // `Number("")` is 0, and this field starts empty on a property saved
    // without a value — so opening the editor and pressing Save without
    // typing wrote a current_value of 0.00. That reads as "this house is
    // worth nothing" rather than "not valued yet", and it is what put a
    // literal 0.00 on a production property.
    const parsed = Number(newValue);
    if (newValue.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
      setEditingValue(false);
      return;
    }
    await update.mutateAsync({ id: asset.id, current_value: parsed });
    setEditingValue(false);
  }

  const categoryLabel = asset.category === "primary_home" ? "Primary Home" : "Rental";
  const categoryVariant = asset.category === "rental" ? "warning" : "secondary";
  const hasCustomThumb = !!(asset.metadata_json as Record<string, unknown> | null)?.custom_thumbnail;
  const hasThumbnailSource = !!meta.zillow_url || hasCustomThumb;
  const [thumbnailUrl, setThumbnailUrl] = usePropertyThumbnail(asset.id, hasThumbnailSource);
  const thumbFileRef = useRef<HTMLInputElement>(null);

  async function handleThumbUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const big = tooLarge(file, UPLOAD_LIMITS.assetPhoto, "The photo");
    if (big) {
      toastError(big);
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    try {
      const result = await api.upload<{ url: string }>(`/assets/${asset.id}/thumbnail`, fd);
      if (result?.url) setThumbnailUrl(result.url);
    } catch (err) {
      toastError((err as Error).message);
    }
  }

  async function handleRemoveThumb() {
    await api.delete(`/assets/${asset.id}/thumbnail`);
    setThumbnailUrl(null);
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header — click to open edit drawer */}
      <div
        className="p-4 flex items-start justify-between gap-4 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onSelect}
      >
        <div className="flex items-center gap-3">
          <input ref={thumbFileRef} type="file" accept="image/*" className="hidden" onChange={handleThumbUpload} />
          <div
            className="relative group cursor-pointer h-12 w-20 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden"
            onClick={(e) => { e.stopPropagation(); thumbFileRef.current?.click(); }}
            title="Upload custom photo"
          >
            {thumbnailUrl
              ? <img src={thumbnailUrl} alt={asset.name} className="h-full w-full object-cover" />
              : <Home size={18} className="text-primary" />
            }
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera size={16} className="text-white" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold">{asset.name}</h3>
              <Badge variant={categoryVariant}>{categoryLabel}</Badge>
            </div>
            {asset.acquired_at && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Acquired {parseLocalDate(asset.acquired_at).toLocaleDateString("en-US", { year: "numeric", month: "short" })}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onSelect}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label={`Edit or delete ${asset.name}`}
          >
            <Pencil size={13} /> Edit
          </button>
          {meta.zillow_url && (
            <a
              href={meta.zillow_url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="View on Zillow"
            >
              <ExternalLink size={14} />
            </a>
          )}
          {thumbnailUrl && hasCustomThumb && (
            <button
              onClick={handleRemoveThumb}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="Remove custom photo"
            >
              <Camera size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Primary stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
        {/* Current Value — click to quick-edit */}
        <div className="bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Current Value</p>
          {editingValue ? (
            <div className="flex items-center gap-1 mt-0.5">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                className="w-24 rounded border border-border bg-background px-2 py-0.5 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveValue();
                  if (e.key === "Escape") setEditingValue(false);
                }}
              />
              <button onClick={saveValue} className="text-xs text-primary font-medium">Save</button>
              <button onClick={() => setEditingValue(false)} className="text-xs text-muted-foreground">×</button>
            </div>
          ) : (
            <button
              onClick={() => { setNewValue(String(asset.current_value ?? "")); setEditingValue(true); }}
              className="font-medium text-sm mt-0.5 hover:text-primary transition-colors"
            >
              {formatCurrency(currentValue)}
            </button>
          )}
        </div>

        <div className="bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Loan Balance</p>
          <p className="font-medium text-sm mt-0.5">
            {asset.loan ? formatCurrency(loanBalance) : "No loan"}
          </p>
        </div>

        <div className="bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Equity</p>
          {equity == null ? (
            <p
              className="font-medium text-sm mt-0.5 text-muted-foreground"
              title="Equity needs the property's current value. Add one above."
            >
              Add a value
            </p>
          ) : (
            <p className={cn("font-medium text-sm mt-0.5", equity >= 0 ? "text-foreground" : "text-destructive")}>
              {formatCurrency(equity)}
            </p>
          )}
        </div>

        <div className="bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Equity %</p>
          <p className="font-medium text-sm mt-0.5">
            {equityPct == null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              `${equityPct.toFixed(1)}%`
            )}
          </p>
        </div>
      </div>

      {/* Rental stats row */}
      {isRental && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
          <div className="bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Ownership</p>
            <p className="font-medium text-sm mt-0.5">{ownershipPct}%</p>
          </div>
          <div className="bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">My Net Worth Share</p>
            <p className="font-medium text-sm mt-0.5">{formatCurrency(myShare)}</p>
          </div>
          <div className="bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Monthly Income (adj.)</p>
            <p className="font-medium text-sm mt-0.5 text-success">{formatCurrency(adjIncome)}</p>
          </div>
          <div className="bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Monthly Expenses (adj.)</p>
            <p className="font-medium text-sm mt-0.5 text-destructive">{formatCurrency(adjExpenses)}</p>
          </div>
        </div>
      )}

      {/* Value trend chart */}
      <ValueTrendChart asset={asset} />

      {/* Mortgage details */}
      {asset.loan && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
            {[
              { label: "Monthly P&I", value: formatCurrency(monthlyPI) },
              { label: "Monthly Escrow", value: formatCurrency(monthlyEscrow) },
              { label: "Rate", value: `${asset.loan.rate_apr}% APR` },
              { label: "Est. Payoff", value: payoffDate ? formatPayoffDate(payoffDate) : "—" },
            ].map((item) => (
              <div key={item.label} className="bg-card px-4 py-3">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="font-medium text-sm mt-0.5">{item.value}</p>
              </div>
            ))}
          </div>

          <button
            onClick={() => setShowSchedule((s) => !s)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-muted-foreground hover:bg-muted/40 transition-colors"
          >
            <span>Amortization Schedule ({asset.loan.term_months} months)</span>
            {showSchedule ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>

          {showSchedule && (
            <div className="max-h-64 overflow-y-auto border-t border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    {["#", "Date", "Principal", "Interest", "Escrow", "Balance"].map((h) => (
                      <th key={h} className="px-3 py-1.5 text-right first:text-left font-medium text-muted-foreground">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {asset.loan.schedule.map((row) => (
                    <tr key={row.month_number} className="hover:bg-muted/20">
                      <td className="px-3 py-1.5">{row.month_number}</td>
                      <td className="px-3 py-1.5 text-right">{row.payment_date}</td>
                      <td className="px-3 py-1.5 text-right">{formatCurrency(row.principal)}</td>
                      <td className="px-3 py-1.5 text-right">{formatCurrency(row.interest)}</td>
                      <td className="px-3 py-1.5 text-right">{formatCurrency(row.escrow)}</td>
                      <td className="px-3 py-1.5 text-right">{formatCurrency(row.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PropertyPage
// ---------------------------------------------------------------------------

export function PropertyPage() {
  const { data: assets = [], isLoading } = useAssets();
  const [params, setParams] = useSearchParams();
  // Deep links from an account's drawer: ?asset=<id> opens that property,
  // ?add=mortgage starts Add Property on the mortgage step.
  const [showAdd, setShowAdd] = useState(params.get("add") === "mortgage");
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(
    params.get("asset") ? Number(params.get("asset")) : null,
  );
  useEffect(() => {
    if (params.has("asset") || params.has("add")) setParams({}, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [addType, setAddType] = useState<"mortgage" | null>(params.get("add") === "mortgage" ? "mortgage" : null);

  const properties = assets.filter((a) => ["primary_home", "rental"].includes(a.category));

  // Derive the open asset from the live list by id (rather than copying it into
  // state). This keeps the drawer showing fresh data after an edit *and* means
  // closing — setSelectedAssetId(null) — can't be undone by the post-save refetch.
  // A previous "sync selectedAsset from assets" effect raced onClose() and
  // re-opened the drawer right after a save. [property save drawer stuck]
  const selectedAsset = selectedAssetId != null
    ? assets.find((a) => a.id === selectedAssetId) ?? null
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {properties.length} propert{properties.length !== 1 ? "ies" : "y"}
        </p>
        <Button size="sm" onClick={() => setShowAdd(true)}>
          <Plus size={13} />
          Add property
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-48 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : properties.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <Home size={32} className="text-muted-foreground mb-3" />
          <p className="font-medium">No properties yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add your primary home or rental properties to track equity and returns.
          </p>
          <Button className="mt-4" size="sm" onClick={() => setShowAdd(true)}>
            <Plus size={13} />
            Add property
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {properties.map((a) => (
            <PropertyCard
              key={a.id}
              asset={a}
              onSelect={() => setSelectedAssetId(a.id)}
            />
          ))}
        </div>
      )}

      <AddPropertyDrawer open={showAdd} initialType={addType} onClose={() => { setShowAdd(false); setAddType(null); }} />
      <EditPropertyDrawer asset={selectedAsset} onClose={() => setSelectedAssetId(null)} />
    </div>
  );
}
