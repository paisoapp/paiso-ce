import { useState } from "react";
import { Copy, Download } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";

/** Recovery codes, shown once. The server keeps only hashes, so this dialog
 *  is the single chance to save them; it will not close on a stray click. */
export function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([`Paiso recovery codes\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "paiso-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  }

  async function copy() {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setSaved(true);
  }

  return (
    <Dialog open onClose={() => { if (saved) onClose(); }} className="md:max-w-sm">
      <DialogHeader>Save your recovery codes</DialogHeader>
      <DialogBody className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Each code signs you in once if you lose your authenticator app. Paiso shows them only now. Store them somewhere safe.
        </p>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={copy}>
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="outline" className="flex-1" onClick={download}>
            <Download size={14} />
            Download
          </Button>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={!saved}>I saved my codes</Button>
      </DialogFooter>
    </Dialog>
  );
}
