import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { useCreateAccount, useCreateMortgage, useUpdateAccount } from "@/hooks/useAccounts";
import { AccountLogo, typeStyle } from "./AccountList";
import { AccountTypeFields, choiceFor, choiceIsComplete, type TypeChoice } from "./AccountKindFields";
import type { Account } from "@/types";
import { ACCOUNT_NAME_MAX, EARLIEST_DATE, todayIso } from "@/lib/validation";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { Upload } from "@/lib/icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onImportCsv?: (account: Account) => void;
}

function MortgageFields({
  form,
  set,
}: {
  form: MortgageForm;
  set: <K extends keyof MortgageForm>(k: K, v: MortgageForm[K]) => void;
}) {
  const totalMonthly =
    (parseFloat(form.monthlyPrincipal) || 0) +
    (parseFloat(form.monthlyInterest) || 0) +
    (parseFloat(form.monthlyEscrow) || 0) +
    (parseFloat(form.extraPrincipal) || 0);

  const labelCls = "text-xs font-medium text-muted-foreground uppercase tracking-wide";
  const inputCls =
    "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60";

  return (
    <div className="space-y-4">
      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Property Details
        </p>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className={labelCls}>Property Address</label>
            <input
              type="text"
              value={form.propertyAddress}
              onChange={(e) => set("propertyAddress", e.target.value)}
              placeholder="e.g. 123 Main St, Springfield"
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Category</label>
              <select
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                className={inputCls}
              >
                <option value="primary_home">Primary Home</option>
                <option value="rental">Rental Property</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Ownership %</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.ownershipPct}
                onChange={(e) => set("ownershipPct", e.target.value)}
                placeholder="100"
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Current Estimated Value ($)</label>
              <input
                type="number"
                step="0.01"
                value={form.currentValue}
                onChange={(e) => set("currentValue", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Purchase Price ($)</label>
              <input
                type="number"
                step="0.01"
                value={form.acquiredValue}
                onChange={(e) => set("acquiredValue", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Acquired Date</label>
              <input
                type="date"
                min={EARLIEST_DATE}
                max={todayIso()}
                value={form.acquiredAt}
                onChange={(e) => set("acquiredAt", e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Zillow URL <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
              <input
                type="url"
                value={form.zillowUrl}
                onChange={(e) => set("zillowUrl", e.target.value)}
                placeholder="https://www.zillow.com/..."
                className={inputCls}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Loan Details
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Total Loan Amount ($)</label>
              <input
                type="number"
                step="0.01"
                value={form.principal}
                onChange={(e) => set("principal", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Loan Start Date</label>
              <input
                type="date"
                min={EARLIEST_DATE}
                value={form.origination}
                onChange={(e) => set("origination", e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Interest Rate (APR %)</label>
              <input
                type="number"
                step="0.001"
                value={form.rateApr}
                onChange={(e) => set("rateApr", e.target.value)}
                placeholder="6.500"
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Term (months)</label>
              <input
                type="number"
                value={form.termMonths}
                onChange={(e) => set("termMonths", e.target.value)}
                placeholder="360"
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Monthly Principal ($)</label>
              <input
                type="number"
                step="0.01"
                value={form.monthlyPrincipal}
                onChange={(e) => set("monthlyPrincipal", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Monthly Interest ($)</label>
              <input
                type="number"
                step="0.01"
                value={form.monthlyInterest}
                onChange={(e) => set("monthlyInterest", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Monthly Escrow ($)</label>
              <input
                type="number"
                step="0.01"
                value={form.monthlyEscrow}
                onChange={(e) => set("monthlyEscrow", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Extra Monthly Principal ($) <span className="normal-case font-normal text-muted-foreground/60">(optional)</span></label>
              <input
                type="number"
                step="0.01"
                value={form.extraPrincipal}
                onChange={(e) => set("extraPrincipal", e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
          </div>

          <div className="rounded-md bg-muted/50 px-3 py-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Total Monthly Payment</span>
            <span className="text-sm font-semibold">
              ${totalMonthly.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Transaction Matching
        </p>
        <div className="space-y-1.5">
          <label className={labelCls}>
            ACH Description Pattern <span className="normal-case font-normal text-muted-foreground/60">(optional)</span>
          </label>
          <p className="text-xs text-muted-foreground/70">
            Text to match against checking account transactions (e.g. "JPMORGAN CHASE"). Used to show mortgage payments in the Mortgage tab.
          </p>
          <input
            type="text"
            value={form.descriptionPattern}
            onChange={(e) => set("descriptionPattern", e.target.value)}
            maxLength={64}
            placeholder="e.g. JPMORGAN CHASE"
            className={inputCls}
          />
        </div>
      </div>
    </div>
  );
}

interface MortgageForm {
  propertyAddress: string;
  category: string;
  ownershipPct: string;
  currentValue: string;
  acquiredValue: string;
  acquiredAt: string;
  zillowUrl: string;
  principal: string;
  origination: string;
  rateApr: string;
  termMonths: string;
  monthlyPrincipal: string;
  monthlyInterest: string;
  monthlyEscrow: string;
  extraPrincipal: string;
  descriptionPattern: string;
}

const EMPTY_MORTGAGE: MortgageForm = {
  propertyAddress: "",
  category: "primary_home",
  ownershipPct: "100",
  currentValue: "",
  acquiredValue: "",
  acquiredAt: "",
  zillowUrl: "",
  principal: "",
  origination: "",
  rateApr: "",
  termMonths: "360",
  monthlyPrincipal: "",
  monthlyInterest: "",
  monthlyEscrow: "",
  extraPrincipal: "",
  descriptionPattern: "",
};

export function AddAccountDialog({ open, onClose, onImportCsv }: Props) {
  const [displayName, setDisplayName] = useState("");
  // Type, and for an investment account its sub-type; account_type follows.
  const [choice, setChoice] = useState<TypeChoice>(choiceFor(null));
  const accountType = choice.accountType;
  const [institution, setInstitution] = useState("");
  const [balanceStr, setBalanceStr] = useState("");
  const [creditLimitStr, setCreditLimitStr] = useState("");
  const [mortgage, setMortgage] = useState<MortgageForm>(EMPTY_MORTGAGE);
  // The add buttons stay enabled and list what is missing.
  const [tried, setTried] = useState(false);

  const create = useCreateAccount();
  const createMortgage = useCreateMortgage();
  const updateAccount = useUpdateAccount();

  const isMortgage = accountType === "mortgage";
  const canImport = !!onImportCsv && !isMortgage;

  function setMortgageField<K extends keyof MortgageForm>(k: K, v: MortgageForm[K]) {
    setMortgage((f) => ({ ...f, [k]: v }));
  }

  function reset() {
    setDisplayName("");
    setChoice(choiceFor(null));
    setInstitution("");
    setBalanceStr("");
    setCreditLimitStr("");
    setMortgage(EMPTY_MORTGAGE);
    setTried(false);
  }

  async function handleSubmit(importAfter = false) {
    setTried(true);
    if (problems.length) return;
    if (isMortgage) {
      await createMortgage.mutateAsync({
        display_name: displayName.trim(),
        institution_name: institution || undefined,
        description_pattern: mortgage.descriptionPattern.trim() || null,
        property_address: mortgage.propertyAddress,
        category: mortgage.category,
        current_value: mortgage.currentValue ? parseFloat(mortgage.currentValue) : null,
        acquired_value: mortgage.acquiredValue ? parseFloat(mortgage.acquiredValue) : null,
        acquired_at: mortgage.acquiredAt || null,
        ownership_pct: parseFloat(mortgage.ownershipPct) || 100,
        zillow_url: mortgage.zillowUrl || null,
        principal: parseFloat(mortgage.principal),
        rate_apr: parseFloat(mortgage.rateApr),
        term_months: parseInt(mortgage.termMonths),
        origination: mortgage.origination,
        extra_principal_monthly: parseFloat(mortgage.extraPrincipal) || 0,
        insurance_monthly: parseFloat(mortgage.monthlyEscrow) || 0,
        property_tax_monthly: 0,
      });
      reset();
      onClose();
      return;
    }

    const parsedBalance = balanceStr.trim() !== "" ? parseFloat(balanceStr) : undefined;
    const parsedCreditLimit = creditLimitStr.trim() !== "" ? parseFloat(creditLimitStr) : undefined;

    const account = await create.mutateAsync({
      display_name: displayName,
      account_type: accountType,
      ...(choice.investmentType ? { investment_type: choice.investmentType, subtype: choice.subtype } : {}),
      institution_name: institution || undefined,
      ...(parsedBalance !== undefined && !isNaN(parsedBalance) ? { current_balance: parsedBalance } : {}),
      ...(parsedCreditLimit !== undefined && !isNaN(parsedCreditLimit) ? { credit_limit: parsedCreditLimit } : {}),
    }) as Account;

    reset();
    onClose();
    if (importAfter && onImportCsv && account) {
      onImportCsv(account);
    }
  }

  const isPending = create.isPending || createMortgage.isPending || updateAccount.isPending;
  const problems: string[] = [];
  if (isMortgage) {
    if (!mortgage.propertyAddress.trim()) problems.push("the property address");
    if (!(Number(mortgage.principal) > 0)) problems.push("the total loan amount");
    if (!mortgage.origination) problems.push("the loan start date");
    if (!(Number(mortgage.rateApr) >= 0) || mortgage.rateApr.trim() === "") problems.push("the interest rate");
    if (!(Number(mortgage.termMonths) > 0)) problems.push("the term in months");
  } else {
    if (!displayName.trim()) problems.push("a name for the account");
    if (!choiceIsComplete(choice)) problems.push("the kind of investment account");
  }
  const problemText = problems.length
    ? `Enter ${problems.length > 1 ? `${problems.slice(0, -1).join(", ")} and ${problems[problems.length - 1]}` : problems[0]}.`
    : null;

  return (
    <SideDrawer open={open} onClose={onClose} title="Add account">
      <div className="flex flex-col gap-5 px-5 py-5">

        {!isMortgage && (
          <div className="space-y-3">
            {/* Names the institution. */}
            <div className="flex items-center gap-3">
              <AccountLogo size="lg" accent={typeStyle(accountType)} />
              <p className="min-w-0 truncate text-sm font-medium">
                {institution.trim() || displayName.trim() || (
                  <span className="text-muted-foreground">New account</span>
                )}
              </p>
            </div>
          </div>
        )}

        {!isMortgage && <hr className="border-border" />}

        {/* Account name */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Account Name {isMortgage && <span className="normal-case font-normal text-muted-foreground/60">(optional, defaults to the lender and address)</span>}
          </label>
          <input
            type="text"
            value={displayName}
            maxLength={ACCOUNT_NAME_MAX}
            aria-label="Account name"
            aria-invalid={tried && !isMortgage && !displayName.trim() ? true : undefined}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={isMortgage ? "e.g. Chase Mortgage" : "e.g. Chase Checking"}
            className={`w-full rounded-md border ${tried && !isMortgage && !displayName.trim() ? "border-destructive" : "border-border"} bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60`}
          />
        </div>

        {/* Account type, then a sub-type for an investment account */}
        <AccountTypeFields value={choice} onChange={setChoice} />

        {/* Institution */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Institution
          </label>
          <input
            type="text"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="e.g. Chase Bank"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Mortgage-specific fields */}
        {isMortgage && (
          <MortgageFields form={mortgage} set={setMortgageField} />
        )}

        {/* Non-mortgage: balance + credit limit */}
        {!isMortgage && (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Current Balance{" "}
                <span className="normal-case font-normal text-muted-foreground/60">(optional)</span>
              </label>
              {accountType === "credit_card" && (
                <p className="text-xs text-muted-foreground/70">Enter the amount currently owed on this card.</p>
              )}
              <MoneyInput
                value={balanceStr}
                onValueChange={setBalanceStr}
                placeholder="0.00"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
              />
            </div>

            {accountType === "credit_card" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Credit Limit{" "}
                  <span className="normal-case font-normal text-muted-foreground/60">(optional)</span>
                </label>
                <MoneyInput
                  allowNegative={false}
                  value={creditLimitStr}
                  onValueChange={setCreditLimitStr}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
                />
              </div>
            )}
          </>
        )}

        {tried && problemText && (
          <p role="alert" className="text-sm text-destructive">{problemText}</p>
        )}
        {(create.error || createMortgage.error) && (
          <p className="text-sm text-destructive">
            {((create.error || createMortgage.error) as Error).message}
          </p>
        )}

        {/* Importing is the usual next step, so it leads when it is offered;
            adding the account alone stays one click away. */}
        {canImport ? (
          <>
            <Button
              onClick={() => handleSubmit(true)}
              disabled={isPending}
              loading={isPending}
              className="w-full"
            >
              <Upload size={14} />
              Add account and import a file
            </Button>
            <Button
              variant="outline"
              onClick={() => handleSubmit(false)}
              disabled={isPending}
              loading={isPending}
              className="w-full"
            >
              Add account
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              You can import a file later from the account or from Transactions.
            </p>
          </>
        ) : (
          <Button
            onClick={() => handleSubmit(false)}
            disabled={isPending}
            loading={isPending}
            className="w-full"
          >
            {isMortgage ? "Add mortgage and property" : "Add account"}
          </Button>
        )}
      </div>
    </SideDrawer>
  );
}
