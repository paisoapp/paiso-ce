import { useEffect, useRef, useState } from "react";
import { Plus, Car, Package, Gem, Archive, Camera, AlertTriangle, EyeOff } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { Badge } from "@/components/ui/badge";
import { useAssets, useCreateAsset, useDeleteAsset, useUpdateAsset } from "@/hooks/useAssets";
import type { Asset } from "@/hooks/useAssets";
import { formatCurrency, cn } from "@/lib/utils";
import { toastError } from "@/components/ui/toast";
import { UPLOAD_LIMITS, tooLarge } from "@/lib/uploadLimits";
import { api, getAccessToken } from "@/lib/api";
import { EARLIEST_DATE, todayIso } from "@/lib/validation";

// ── Brand colors for vehicles ─────────────────────────────────────────────────

const VEHICLE_BRAND_COLORS: Record<string, string> = {
  toyota: "#eb0a1e", honda: "#cc0000", ford: "#003087", chevrolet: "#c8a700",
  chevy: "#c8a700", bmw: "#1c69d4", mercedes: "#00adef", benz: "#00adef",
  audi: "#bb0a21", tesla: "#e82127", nissan: "#c3002f", hyundai: "#002c5f",
  kia: "#bb162b", volkswagen: "#001e50", vw: "#001e50", subaru: "#003893",
  jeep: "#373737", ram: "#d93025", dodge: "#d93025", lexus: "#1a1a1a",
  acura: "#cc0000", mazda: "#910101", volvo: "#003057", porsche: "#d5001c",
  infiniti: "#1f1f1f", cadillac: "#282828", buick: "#0a2f6e", gmc: "#cc0000",
  chrysler: "#1b4b8a", lincoln: "#c9a96e", genesis: "#1c3040",
};

function vehicleBrandColor(name: string): string {
  const first = name.trim().split(/\s+/)[0].toLowerCase();
  return VEHICLE_BRAND_COLORS[first] ?? "#6366f1";
}

function vehicleBrandInitials(name: string): string {
  return name.trim().split(/\s+/)[0].slice(0, 2).toUpperCase();
}

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  vehicle: Car, precious_metal: Gem, collectible: Archive, other: Package,
};
const CATEGORY_LABELS: Record<string, string> = {
  vehicle: "Vehicle", precious_metal: "Precious Metal", collectible: "Collectible", other: "Other",
};

// ── AssetThumbnail ────────────────────────────────────────────────────────────

function AssetThumbnail({ asset, customUrl, onUploadClick }: { asset: Asset; customUrl: string | null; onUploadClick: () => void }) {
  const isVehicle = asset.category === "vehicle";
  // The thumbnail route returns the uploaded photo, or for a vehicle the one
  // the server finds on Wikipedia. The page used to run that lookup again
  // from the browser, which the CSP's connect-src blocks.
  const displayUrl = customUrl;
  const color = isVehicle ? vehicleBrandColor(asset.name) : "";
  const Icon = CATEGORY_ICONS[asset.category] ?? Package;

  return (
    <div className="relative group cursor-pointer shrink-0" onClick={(e) => { e.stopPropagation(); onUploadClick(); }} title="Upload custom photo">
      {displayUrl ? (
        <div className="h-12 w-20 rounded-lg overflow-hidden bg-muted">
          <img src={displayUrl} alt={asset.name} className="h-full w-full object-cover" />
        </div>
      ) : isVehicle ? (
        <div className="h-12 w-20 rounded-lg flex items-center justify-center relative overflow-hidden"
          style={{ backgroundColor: color + "22", border: `1.5px solid ${color}44` }}>
          <Car size={20} style={{ color }} className="absolute opacity-20" />
          <span className="text-sm font-bold relative z-10" style={{ color }}>{vehicleBrandInitials(asset.name)}</span>
        </div>
      ) : (
        <div className="h-12 w-20 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon size={20} className="text-primary" />
        </div>
      )}
      <div className="absolute inset-0 rounded-lg bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <Camera size={16} className="text-white" />
      </div>
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const labelCls = "text-xs font-medium text-muted-foreground uppercase tracking-wide";
const inputCls = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60";

// ── Add Asset Drawer ──────────────────────────────────────────────────────────

type AddForm = {
  name: string; category: string; value: string; acquired_value: string; acquired_at: string;
  hasLoan: boolean; principal: string; rate: string; term: string; origination: string;
};
const BLANK_ADD: AddForm = {
  name: "", category: "vehicle", value: "", acquired_value: "", acquired_at: "",
  hasLoan: false, principal: "", rate: "", term: "60", origination: "",
};

function AddAssetDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateAsset();
  const [form, setForm] = useState<AddForm>(BLANK_ADD);
  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  function handleClose() { setForm(BLANK_ADD); onClose(); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await create.mutateAsync({
      category: form.category,
      name: form.name,
      current_value: form.value ? Number(form.value) : undefined,
      acquired_value: form.acquired_value ? Number(form.acquired_value) : undefined,
      acquired_at: form.acquired_at || undefined,
      loan: form.hasLoan ? {
        principal: Number(form.principal),
        rate_apr: Number(form.rate),
        term_months: Number(form.term),
        origination: form.origination,
      } : undefined,
    });
    handleClose();
  }

  return (
    <SideDrawer open={open} onClose={handleClose} title="Add asset">
      <form onSubmit={submit} className="px-5 py-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={labelCls}>Asset Name</label>
            <input required type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Category</label>
            <select value={form.category} onChange={(e) => set("category", e.target.value)} className={inputCls}>
              <option value="vehicle">Vehicle</option>
              <option value="precious_metal">Precious Metal</option>
              <option value="collectible">Collectible</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={labelCls}>Current Value ($)</label>
            <input type="number" value={form.value} onChange={(e) => set("value", e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Purchase Price ($)</label>
            <input type="number" value={form.acquired_value} onChange={(e) => set("acquired_value", e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className={labelCls}>Acquired Date</label>
          <input type="date" min={EARLIEST_DATE} max={todayIso()} value={form.acquired_at} onChange={(e) => set("acquired_at", e.target.value)} className={inputCls} />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={form.hasLoan} onChange={(e) => set("hasLoan", e.target.checked)} />
          Add loan (auto, personal, etc.)
        </label>
        {form.hasLoan && (
          <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Principal ($)</label>
              <input required type="number" value={form.principal} onChange={(e) => set("principal", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Rate (APR %)</label>
              <input required type="number" step="0.001" value={form.rate} onChange={(e) => set("rate", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Term (months)</label>
              <input type="number" value={form.term} onChange={(e) => set("term", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Origination Date</label>
              <input required={form.hasLoan} type="date" min={EARLIEST_DATE} value={form.origination} onChange={(e) => set("origination", e.target.value)} className={inputCls} />
            </div>
          </div>
        )}

        {create.error && <p className="text-sm text-destructive">{(create.error as Error).message}</p>}
        <Button type="submit" loading={create.isPending} className="w-full">Add asset</Button>
      </form>
    </SideDrawer>
  );
}

// ── Edit Asset Drawer ─────────────────────────────────────────────────────────

type EditForm = {
  name: string; category: string; value: string; acquired_value: string; acquired_at: string;
  exclude_from_net_worth: boolean;
};

function EditAssetDrawer({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const update = useUpdateAsset();
  const deleteAsset = useDeleteAsset();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<EditForm>({
    name: "", category: "vehicle", value: "", acquired_value: "", acquired_at: "", exclude_from_net_worth: false,
  });

  const assetId = asset?.id;
  useEffect(() => {
    if (asset) {
      const meta = (asset.metadata_json as Record<string, unknown> | null) ?? {};
      setForm({
        name: asset.name,
        category: asset.category,
        value: String(asset.current_value ?? ""),
        acquired_value: String(asset.acquired_value ?? ""),
        acquired_at: asset.acquired_at ?? "",
        exclude_from_net_worth: !!meta.exclude_from_net_worth,
      });
      setConfirmDelete(false);
    }
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!asset) return;
    const existingMeta = (asset.metadata_json as Record<string, unknown> | null) ?? {};
    const newMeta: Record<string, unknown> = { ...existingMeta };
    if (form.exclude_from_net_worth) newMeta.exclude_from_net_worth = true;
    else delete newMeta.exclude_from_net_worth;

    await update.mutateAsync({
      id: asset.id,
      name: form.name,
      category: form.category,
      current_value: form.value ? Number(form.value) : undefined,
      acquired_value: form.acquired_value ? Number(form.acquired_value) : undefined,
      acquired_at: form.acquired_at || undefined,
      metadata_json: newMeta,
    });
    onClose();
  }

  async function handleDelete() {
    if (!asset) return;
    await deleteAsset.mutateAsync(asset.id);
    onClose();
  }

  return (
    <SideDrawer open={asset != null} onClose={onClose} title={asset?.name ?? "Edit asset"}>
      {asset && (
        <form onSubmit={handleSave} className="px-5 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Asset Name</label>
              <input required type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Category</label>
              <select value={form.category} onChange={(e) => set("category", e.target.value)} className={inputCls}>
                <option value="vehicle">Vehicle</option>
                <option value="precious_metal">Precious Metal</option>
                <option value="collectible">Collectible</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Current Value ($)</label>
              <input type="number" value={form.value} onChange={(e) => set("value", e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Purchase Price ($)</label>
              <input type="number" value={form.acquired_value} onChange={(e) => set("acquired_value", e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Acquired Date</label>
            <input type="date" min={EARLIEST_DATE} max={todayIso()} value={form.acquired_at} onChange={(e) => set("acquired_at", e.target.value)} className={inputCls} />
          </div>

          {/* Loan summary (read-only) */}
          {asset.loan && (
            <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1 text-sm">
              <p className={labelCls + " mb-1"}>Loan</p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Balance owed</span>
                <span className="font-medium">{formatCurrency(asset.loan.current_balance)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Monthly payment</span>
                <span className="font-medium">{formatCurrency(asset.loan.monthly_payment)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rate</span>
                <span className="font-medium">{asset.loan.rate_apr}% APR</span>
              </div>
            </div>
          )}

          {/* Exclude toggle */}
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
                <p className="text-xs text-muted-foreground mt-0.5">This asset will not be counted in your total net worth.</p>
              </div>
            </label>
          </div>

          {update.error && <p className="text-sm text-destructive">{(update.error as Error).message}</p>}
          <Button type="submit" loading={update.isPending} className="w-full">Save changes</Button>

          <hr className="border-border" />

          {confirmDelete ? (
            <div className="space-y-2">
              <p className="text-xs text-destructive text-center">Delete {asset.name}? This cannot be undone.</p>
              <div className="flex gap-2">
                <Button type="button" variant="destructive" size="sm" className="flex-1" onClick={handleDelete} loading={deleteAsset.isPending}>
                  <AlertTriangle size={13} /> Confirm delete
                </Button>
                <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
            >
              Delete asset
            </button>
          )}
        </form>
      )}
    </SideDrawer>
  );
}

// ── Asset Card ────────────────────────────────────────────────────────────────

function AssetCard({ asset, onSelect }: { asset: Asset; onSelect: () => void }) {
  const equity = (asset.current_value ?? 0) - (asset.loan?.current_balance ?? 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const meta = (asset.metadata_json as Record<string, unknown> | null) ?? {};
  const isExcluded = !!meta.exclude_from_net_worth;

  useEffect(() => {
    if (!meta.custom_thumbnail) { setCustomUrl(null); return; }
    const token = getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    fetch(`/api/assets/${asset.id}/thumbnail`, { headers, credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.url) setCustomUrl(d.url); })
      .catch(() => null);
  }, [asset.id, asset.metadata_json]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
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
      if (result?.url) setCustomUrl(result.url);
    } catch (err) {
      toastError((err as Error).message);
    }
  }

  async function handleRemoveThumbnail(e: React.MouseEvent) {
    e.stopPropagation();
    await api.delete(`/assets/${asset.id}/thumbnail`);
    setCustomUrl(null);
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-muted/30 transition-colors",
        isExcluded && "opacity-60",
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-3 min-w-0">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
        <AssetThumbnail
          asset={asset}
          customUrl={customUrl}
          onUploadClick={() => fileRef.current?.click()}
        />
        <div className="min-w-0">
          <p className="font-medium truncate flex items-center gap-1.5">
            {asset.name}
            {isExcluded && <span title="Excluded from net worth"><EyeOff size={12} className="text-muted-foreground shrink-0" /></span>}
          </p>
          <p className="text-xs text-muted-foreground">{CATEGORY_LABELS[asset.category] ?? asset.category}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="text-right">
          <p className="font-semibold">{formatCurrency(asset.current_value ?? 0)}</p>
          {asset.loan && (
            <p className="text-xs text-muted-foreground">Equity: {formatCurrency(equity)}</p>
          )}
        </div>
        {asset.loan && (
          <Badge variant="secondary">{formatCurrency(asset.loan.current_balance)} owed</Badge>
        )}
        {customUrl && (
          <button
            onClick={handleRemoveThumbnail}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Remove custom photo"
          >
            <Camera size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Other Assets Page ─────────────────────────────────────────────────────────

export function OtherAssetsPage() {
  const { data: assets = [], isLoading } = useAssets();
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  // Derive the open asset from the live list by id (rather than copying it into
  // state) so the drawer shows fresh data after an edit *and* closing can't be
  // undone by the post-save refetch. A previous "sync editing from assets" effect
  // raced onClose() and re-opened the drawer after a save. [asset save drawer stuck]
  const editing = editingId != null
    ? assets.find((a) => a.id === editingId) ?? null
    : null;

  const otherAssets = assets.filter((a) => !["primary_home", "rental"].includes(a.category));
  const totalValue = otherAssets.reduce((s, a) => s + (a.current_value ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {otherAssets.length} asset{otherAssets.length !== 1 ? "s" : ""} · Total: <strong>{formatCurrency(totalValue)}</strong>
        </p>
        <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={13} />Add asset</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />)}</div>
      ) : otherAssets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <Package size={32} className="text-muted-foreground mb-3" />
          <p className="font-medium">No other assets yet</p>
          <Button className="mt-4" size="sm" onClick={() => setShowAdd(true)}><Plus size={13} />Add asset</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {otherAssets.map((a) => (
            <AssetCard key={a.id} asset={a} onSelect={() => setEditingId(a.id)} />
          ))}
        </div>
      )}

      <AddAssetDrawer open={showAdd} onClose={() => setShowAdd(false)} />
      <EditAssetDrawer asset={editing} onClose={() => setEditingId(null)} />
    </div>
  );
}
