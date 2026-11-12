import { useEffect, useState } from "react";
import { CheckCircle, Plus, Upload } from "@/lib/icons";
import { formatCurrency } from "@/lib/utils";
import { useAccounts } from "@/hooks/useAccounts";
import { AddAccountDialog } from "@/components/accounts/AddAccountDialog";
import { CsvImportWizard } from "@/components/accounts/CsvImportWizard";
import type { Account } from "@/types";

const primaryBtn =
  "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50";
const secondaryBtn =
  "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-border rounded-md hover:bg-muted";

function AccountsSoFar({
  accounts, onImport,
}: {
  accounts: Account[];
  onImport: (a: Account) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {accounts.map((a) => (
        <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <CheckCircle className="h-4 w-4 shrink-0 text-success" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{a.display_name}</span>
            {a.institution_name && (
              <span className="block truncate text-xs text-muted-foreground">
                {a.institution_name}
              </span>
            )}
          </span>
          {a.current_balance != null && (
            <span className="tabular-nums text-muted-foreground">
              {formatCurrency(a.current_balance)}
            </span>
          )}
          <button
            onClick={() => onImport(a)}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Upload className="h-3.5 w-3.5" />
            Import a file
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Getting the user's data in: add an account by hand, then import a CSV or
 * OFX/QFX file into it.
 */
export function DataStep() {
  const { data: accounts = [] } = useAccounts();
  const [manualOpen, setManualOpen] = useState(false);
  const [importing, setImporting] = useState<Account | null>(null);

  useEffect(() => {
  }, []);

  const hasAccounts = accounts.length > 0;

  return (
    <div className="space-y-5 max-w-xl">
      <div className="rounded-lg border border-border p-5 space-y-3">
        <p className="font-medium">
          {hasAccounts ? "Add another account" : "Add your first account"}
        </p>
        <p className="text-sm text-muted-foreground">
          Start with the account you use most. Enter its name and balance, then import its
          transactions from a file your bank lets you download.{" "}
          Most banks offer a CSV or a Quicken (QFX) download on the statements or activity page.
        </p>
        <button onClick={() => setManualOpen(true)} className={hasAccounts ? secondaryBtn : primaryBtn}>
          <Plus className="h-4 w-4" />
          Add an account
        </button>
      </div>

      {hasAccounts && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {accounts.length === 1 ? "1 account added" : `${accounts.length} accounts added`}
          </p>
          <AccountsSoFar accounts={accounts} onImport={setImporting} />
        </div>
      )}

      <AddAccountDialog
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        onImportCsv={(acct) => setImporting(acct)}
      />
      {importing && (
        <CsvImportWizard
          open
          onClose={() => setImporting(null)}
          accountId={importing.id}
          accountName={importing.display_name}
        />
      )}
    </div>
  );
}
