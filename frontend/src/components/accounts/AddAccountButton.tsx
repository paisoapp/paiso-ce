import { useState } from "react";
import { Plus } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { AddAccountDialog } from "./AddAccountDialog";
import { CsvImportWizard } from "./CsvImportWizard";
import type { Account } from "@/types";

/**
 * "Add account", for the section pages — Portfolio, Investments, Budgeting,
 * Transactions.
 *
 * Adding an account used to mean leaving whatever you were doing and finding
 * it in Settings. It opens the same drawer that page does, so this is an entry
 * point rather than a second implementation. [issue 210]
 *
 * The CSV wizard comes along because the drawer can hand an account straight
 * to it after creating one, and dropping that would make the flow dead-end
 * away from Settings.
 */
export function AddAccountButton({
  label = "Add account",
  size = "sm",
  variant = "outline",
  className,
}: {
  label?: string;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "destructive" | "ghost" | "outline";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState<Account | null>(null);

  return (
    <>
      <Button
        size={size} variant={variant} className={className}
        onClick={() => setOpen(true)}
      >
        <Plus size={14} />
        {label}
      </Button>

      <AddAccountDialog
        open={open}
        onClose={() => setOpen(false)}
        onImportCsv={(acct) => setImporting(acct)}
      />

      {importing && (
        <CsvImportWizard
          open={!!importing}
          onClose={() => setImporting(null)}
          accountId={importing.id}
          accountName={importing.display_name}
        />
      )}
    </>
  );
}
