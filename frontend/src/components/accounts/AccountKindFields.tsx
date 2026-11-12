import { useAccountClassification } from "@/hooks/useAccounts";
import type { Account } from "@/types";

/** Coarse account types that are investment accounts. */
const INVESTMENT_ACCOUNT_TYPES = new Set(["brokerage", "401k", "ira", "roth_ira", "hsa", "529"]);

/** Account types with no sub-type, in the order the picker lists them. */
const PLAIN_TYPES = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan" },
  { value: "mortgage", label: "Mortgage" },
];

/** What the type picker produces. For an investment account `investmentType`
 *  and `subtype` are set and `accountType` follows the sub-type; for any
 *  other account they are "". */
export interface TypeChoice {
  accountType: string;
  investmentType: string;
  subtype: string;
}

export function choiceFor(account: Account | null | undefined): TypeChoice {
  if (!account) return { accountType: "checking", investmentType: "", subtype: "" };
  const isInvestment = INVESTMENT_ACCOUNT_TYPES.has(account.account_type);
  return {
    accountType: account.account_type,
    investmentType: isInvestment ? account.investment_type ?? "investing" : "",
    subtype: isInvestment ? account.subtype ?? "" : "",
  };
}

/** Whether the choice is complete enough to save. */
export function choiceIsComplete(c: TypeChoice): boolean {
  return !c.investmentType || !!c.subtype;
}

const fieldClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50";
const labelClass = "text-xs font-medium text-muted-foreground uppercase tracking-wide";

/**
 * Account type, then — for an investment account — its sub-type from a short
 * list for that type (Retirement → 401(k), Roth IRA …). The type is what the
 * account is for and which Investments tab it is on; the sub-type decides how
 * it is taxed.
 */
export function AccountTypeFields({
  value,
  onChange,
  investmentOnly = false,
}: {
  value: TypeChoice;
  onChange: (next: TypeChoice) => void;
  /** Offer only the investment types (an investment tab's drawer). */
  investmentOnly?: boolean;
}) {
  const { data } = useAccountClassification();
  const types = data?.types ?? [];
  const current = types.find((t) => t.value === value.investmentType);
  const selected = value.investmentType ? `inv:${value.investmentType}` : value.accountType;

  function pickType(key: string) {
    if (key.startsWith("inv:")) {
      const t = types.find((x) => `inv:${x.value}` === key);
      // A type with one sub-type (Health → HSA) needs no second choice.
      const only = t && t.subtypes.length === 1 ? t.subtypes[0] : null;
      onChange({
        investmentType: t?.value ?? "",
        subtype: only?.value ?? "",
        accountType: only?.account_type ?? "brokerage",
      });
    } else {
      onChange({ accountType: key, investmentType: "", subtype: "" });
    }
  }

  return (
    <>
      <div className="space-y-1.5">
        <label className={labelClass}>Account Type</label>
        <select value={selected} onChange={(e) => pickType(e.target.value)} className={fieldClass}>
          {!investmentOnly && PLAIN_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
          {types.map((t) => (
            <option key={t.value} value={`inv:${t.value}`}>{t.label}</option>
          ))}
          {!investmentOnly && <option value="other">Other</option>}
        </select>
      </div>

      {current && current.subtypes.length > 1 && (
        <div className="space-y-1.5">
          <label className={labelClass}>Sub-type</label>
          <select
            value={value.subtype}
            onChange={(e) => {
              const s = current.subtypes.find((x) => x.value === e.target.value);
              onChange({ ...value, subtype: e.target.value, accountType: s?.account_type ?? value.accountType });
            }}
            className={fieldClass}
          >
            <option value="" disabled>Choose…</option>
            {current.subtypes.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          {value.subtype && (
            <p className="text-xs text-muted-foreground/70">
              {current.subtypes.find((s) => s.value === value.subtype)?.tax_treatment_label}
            </p>
          )}
        </div>
      )}
    </>
  );
}
