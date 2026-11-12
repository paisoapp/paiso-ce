import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, RotateCcw } from "@/lib/icons";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { clickableCardClass } from "@/components/ui/card-link";
import { AccountLogo, typeStyle } from "@/components/accounts/AccountList";
import { AssetBreakdownDonut } from "@/components/portfolio/AssetBreakdownDonut";
import { FeeAnalysisCard } from "@/components/portfolio/FeeAnalysisCard";
import { NetWorthTrendChart } from "@/components/portfolio/NetWorthTrendChart";
import { usePortfolioBreakdown, usePortfolioSummary } from "@/hooks/usePortfolio";
import type { AccountRow, AssetRow } from "@/hooks/usePortfolio";
import { useAssets, useUpdateAsset } from "@/hooks/useAssets";
import { accountHref, navigateFromClick } from "@/lib/navTargets";
import { formatCurrency, cn } from "@/lib/utils";
import { ResponsiveList, MobileRowCard, MobileRowMeta } from "@/components/ui/responsive-list";
import { AddAccountButton } from "@/components/accounts/AddAccountButton";

function Stat({ label, value, sub, color, to }: { label: string; value: string; sub?: string; color?: string; to?: string }) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-1 ${color ?? ""}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </>
  );
  const cls = "block rounded-xl border border-border bg-card px-4 py-4 sm:px-5";
  return to ? <Link to={to} className={cn(cls, clickableCardClass)}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** Scroll to the element a `#hash` names — how Dashboard and in-page links
 *  land on a section. Keyed on the location, so re-clicking the same link
 *  scrolls again after the user has moved away. */
function useHashScroll(ready: boolean) {
  const location = useLocation();
  useEffect(() => {
    if (!ready || !location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    // `#liabilities` names no one element — the debt sections can sit
    // anywhere in the user's order — so it lands on whichever comes first.
    const el = id === LIABILITIES_ANCHOR
      ? document.querySelector(LIABILITY_SECTIONS.map((s) => `#section-${s}`).join(", "))
      : document.getElementById(id);
    // After paint, so a section the hash just expanded has its full height.
    const t = window.setTimeout(() => el?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    return () => window.clearTimeout(t);
  }, [ready, location.key, location.hash]);
}

// ── Include / exclude from net worth toggle ───────────────────────────────────

/** Small inline control to include/exclude an asset from net worth straight from
 *  the portfolio tables. Writes through to the same backend field the edit
 *  drawers use, so the setting is honored everywhere. [issue 5] */
function ExcludeToggle({
  excluded,
  onToggle,
}: {
  excluded: boolean;
  onToggle: (nextExcluded: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(!excluded);
      }}
      title={excluded ? "Include in net worth" : "Exclude from net worth"}
      aria-pressed={excluded}
      className={cn(
        "inline-flex items-center justify-center rounded p-1 transition-colors",
        excluded
          ? "text-muted-foreground hover:text-foreground"
          : "text-muted-foreground/50 hover:text-foreground",
      )}
    >
      {excluded ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
}

// ── Breakdown table ───────────────────────────────────────────────────────────

// ── Account Details order ───────────────────────────────────────────────────

/** The Account Details sections in their default order. The user can drag
 *  them into any order; that order is saved per account in ui_prefs. */
const SECTION_ORDER = [
  "cash", "investments", "credit-cards", "loans", "property", "other-assets",
] as const;
type SectionId = (typeof SECTION_ORDER)[number];

const LIABILITIES_ANCHOR = "liabilities";
const LIABILITY_SECTIONS: SectionId[] = ["credit-cards", "loans"];

/** The saved order with unknown ids dropped and any section it doesn't
 *  mention (e.g. one added in a later release) appended in default order. */
function resolveSectionOrder(saved: string[] | null): SectionId[] {
  const known = new Set<string>(SECTION_ORDER);
  const kept = (saved ?? []).filter((id, i, all): id is SectionId => known.has(id) && all.indexOf(id) === i);
  return [...kept, ...SECTION_ORDER.filter((id) => !kept.includes(id))];
}

/** One draggable section. The drag starts only from the grip handle, so the
 *  header stays a normal collapse toggle and the rows stay clickable. */
function SortableSection({ id, children }: { id: string; children: (handle: ReactNode) => ReactNode }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      className="touch-none cursor-grab active:cursor-grabbing self-stretch flex items-center pl-3 pr-1 text-muted-foreground/60 hover:text-foreground"
      aria-label="Drag to reorder this section"
      title="Drag to reorder"
    >
      <GripVertical size={16} />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "z-20 opacity-90 shadow-lg rounded-xl")}
    >
      {children(handle)}
    </div>
  );
}

function SectionTable({
  id,
  title,
  count,
  total,
  totalLabel,
  pctOf,
  children,
  defaultOpen = true,
  dragHandle,
}: {
  /** Anchor for `#section-…` links; also opens the section when targeted. */
  id: string;
  /** Grip rendered at the start of the header when the section is sortable. */
  dragHandle?: ReactNode;
  title: string;
  count: number;
  total: number;
  totalLabel: string;
  /** Denominator (e.g. total assets or total liabilities) this section's total
   *  is shown as a percentage of — gives an at-a-glance breakdown of how each
   *  asset/liability class contributes to the whole. Omitted when unknown. */
  pctOf?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { hash, key } = useLocation();
  const anchor = `section-${id}`;
  useEffect(() => {
    const liabilityLink = hash === `#${LIABILITIES_ANCHOR}` && LIABILITY_SECTIONS.includes(id as SectionId);
    if (hash === `#${anchor}` || liabilityLink) setOpen(true);
  }, [hash, key, anchor, id]);

  if (count === 0) return null;

  const pct = pctOf && pctOf > 0 ? (Math.abs(total) / pctOf) * 100 : null;

  return (
    <div id={anchor} className="rounded-xl border border-border bg-card overflow-hidden scroll-mt-4">
      <div className="flex items-center hover:bg-muted/40 transition-colors">
        {dragHandle}
        <button
          className={cn("flex-1 min-w-0 flex items-center gap-3 py-3 pr-4 text-left", dragHandle ? "pl-1" : "pl-4")}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {/* Title and total share one line from sm up; on a phone they stack,
              so neither has to be truncated to fit beside the other. */}
          <div className="flex-1 min-w-0 flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-sm">{title}</span>
              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{count}</span>
            </div>
            <span className="text-xs sm:text-sm font-semibold tabular-nums">
              <span className="font-normal text-muted-foreground sm:font-semibold sm:text-foreground">{totalLabel}:</span>{" "}
              {formatCurrency(Math.abs(total))}
              {pct != null && <span className="text-muted-foreground font-normal"> ({pct.toFixed(1)}%)</span>}
            </span>
          </div>
          {open ? <ChevronUp size={14} className="text-muted-foreground shrink-0" /> : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-border overflow-x-auto">
          {children}
        </div>
      )}
    </div>
  );
}

/** Account-type pill, color-coded the same way as the Settings account cards. */
function TypeBadge({ type, label }: { type: string; label: string }) {
  const style = typeStyle(type);
  return (
    <span className={cn("inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full", style.tile, style.text)}>
      {label}
    </span>
  );
}

/** Institution name beside an account tile, for table rows and mobile cards. */
function InstitutionCell({ institution }: { institution: string | null }) {
  if (!institution) return <>—</>;
  return (
    <span className="flex items-center gap-2 min-w-0 max-w-[12rem] xl:max-w-[16rem]" title={institution}>
      <AccountLogo size="sm" />
      <span className="truncate">{institution}</span>
    </span>
  );
}

/** A name cell that truncates instead of pushing the amount columns off
 *  screen; the full name is in the tooltip. */
const NAME_CELL = "flex items-center gap-1.5 min-w-0 max-w-[14rem] sm:max-w-[20rem] xl:max-w-[28rem]";

function AccountTable({ rows, amountKey, amountLabel, negate = false }: {
  rows: AccountRow[];
  amountKey: "balance" | "value";
  amountLabel: string;
  negate?: boolean;
}) {
  // Each row opens the page for its account type (a 401(k) its tracker, a
  // card its transactions).
  const navigate = useNavigate();
  const hrefFor = (r: AccountRow) => accountHref(r.type, r.id);

  const cards = (
    <div className="p-2 space-y-2">
      {rows.map((r) => {
        const raw = r[amountKey] ?? 0;
        const amount = negate ? -raw : raw;
        return (
          <MobileRowCard
            key={r.id}
            onClick={() => navigate(hrefFor(r))}
            title={<span data-private>{r.name}</span>}
            subtitle={[r.institution, r.type_label, r.excluded ? "Excluded" : null]
              .filter(Boolean).join(" · ")}
            value={`${amount < 0 ? "\u2212" : ""}${formatCurrency(Math.abs(amount))}`}
            valueClassName={amount < 0 ? "text-destructive" : amount > 0 ? "text-foreground" : "text-muted-foreground"}
          />
        );
      })}
    </div>
  );

  const table = (
    <table className="w-full text-sm">
      <thead className="bg-muted/50">
        <tr>
          <th className="px-4 py-2 text-left font-medium text-muted-foreground">Account</th>
          <th className="px-4 py-2 text-left font-medium text-muted-foreground">Institution</th>
          <th className="px-4 py-2 text-left font-medium text-muted-foreground">Type</th>
          <th className="px-4 py-2 text-right font-medium text-muted-foreground">{amountLabel}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => {
          const raw = r[amountKey] ?? 0;
          const amount = negate ? -raw : raw;
          return (
            <tr
              key={r.id}
              onClick={(e) => navigateFromClick(e, hrefFor(r), navigate)}
              className={cn("hover:bg-muted/40 transition-colors cursor-pointer", r.excluded && "opacity-60")}
            >
              <td className="px-4 py-2.5 font-medium">
                <span className={NAME_CELL}>
                  <Link to={hrefFor(r)} title={r.name} className="hover:underline truncate" data-private>{r.name}</Link>
                  {r.excluded && <span title="Excluded from net worth"><EyeOff size={11} className="text-muted-foreground" /></span>}
                </span>
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                <InstitutionCell institution={r.institution} />
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <TypeBadge type={r.type} label={r.type_label} />
                </span>
              </td>
              <td className={cn("px-4 py-2.5 text-right tabular-nums font-medium whitespace-nowrap",
                amount < 0 ? "text-destructive" : amount > 0 ? "text-foreground" : "text-muted-foreground"
              )}>
                {amount < 0 ? "\u2212" : ""}{formatCurrency(Math.abs(amount))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return <ResponsiveList table={table} cards={cards} />;
}

function AssetTable({ rows, showLoan = false, onToggleExclude, href }: {
  rows: AssetRow[];
  showLoan?: boolean;
  onToggleExclude?: (id: number, nextExcluded: boolean) => void;
  /** The Investments tab these assets are managed on. */
  href: string;
}) {
  const navigate = useNavigate();
  const cards = (
    <div className="p-2 space-y-2">
      {rows.map((r) => {
        const val = r.property_value ?? r.value ?? 0;
        const loan = r.loan_balance;
        const equity = r.equity ?? (val - loan);
        const excluded = r.exclude_from_net_worth ?? false;
        return (
          <MobileRowCard
            key={r.id}
            className={cn(excluded && "opacity-60")}
            title={<Link to={href} className="hover:underline" data-private>{r.name}</Link>}
            subtitle={excluded ? `${r.type_label} · Excluded from net worth` : r.type_label}
            value={val > 0 ? formatCurrency(val) : "—"}
            meta={
              showLoan ? (
                <>
                  <MobileRowMeta label="Loan">
                    <span className={loan > 0 ? "text-destructive" : undefined}>
                      {loan > 0 ? formatCurrency(loan) : "—"}
                    </span>
                  </MobileRowMeta>
                  <MobileRowMeta label="Equity">
                    <span className={equity >= 0 ? "text-success" : "text-destructive"}>
                      {formatCurrency(equity)}
                    </span>
                  </MobileRowMeta>
                </>
              ) : undefined
            }
            actions={
              onToggleExclude ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {excluded ? "Excluded" : "Counted"}
                  <ExcludeToggle excluded={excluded} onToggle={(next) => onToggleExclude(r.id, next)} />
                </span>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );

  const table = (
    <table className="w-full text-sm">
      <thead className="bg-muted/50">
        <tr>
          <th className="px-4 py-2 text-left font-medium text-muted-foreground">Name</th>
          <th className="px-4 py-2 text-left font-medium text-muted-foreground">Type</th>
          <th className="px-4 py-2 text-right font-medium text-muted-foreground">Value</th>
          {showLoan && <th className="px-4 py-2 text-right font-medium text-muted-foreground">Loan Balance</th>}
          {showLoan && <th className="px-4 py-2 text-right font-medium text-muted-foreground">Equity</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => {
          const val = r.property_value ?? r.value ?? 0;
          const loan = r.loan_balance;
          const equity = r.equity ?? (val - loan);
          const excluded = r.exclude_from_net_worth ?? false;
          return (
            <tr
              key={r.id}
              onClick={(e) => navigateFromClick(e, href, navigate)}
              className={cn("hover:bg-muted/40 transition-colors cursor-pointer", excluded && "opacity-60")}
            >
              <td className="px-4 py-2.5 font-medium">
                <span className={NAME_CELL}>
                  {onToggleExclude && (
                    <ExcludeToggle excluded={excluded} onToggle={(next) => onToggleExclude(r.id, next)} />
                  )}
                  <Link to={href} title={r.name} className="hover:underline truncate" data-private>{r.name}</Link>
                  {excluded && !onToggleExclude && (
                    <span title="Excluded from net worth" className="inline-flex">
                      <EyeOff size={12} className="text-muted-foreground" />
                    </span>
                  )}
                </span>
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{r.type_label}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-medium whitespace-nowrap">
                {val > 0 ? formatCurrency(val) : "—"}
              </td>
              {showLoan && (
                <td className="px-4 py-2.5 text-right tabular-nums text-destructive font-medium whitespace-nowrap">
                  {loan > 0 ? formatCurrency(loan) : "—"}
                </td>
              )}
              {showLoan && (
                <td className={cn("px-4 py-2.5 text-right tabular-nums font-medium whitespace-nowrap",
                  equity >= 0 ? "text-success" : "text-destructive"
                )}>
                  {formatCurrency(equity)}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return <ResponsiveList table={table} cards={cards} />;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function PortfolioPage() {
  const { data, isLoading } = usePortfolioSummary();
  const { data: breakdown } = usePortfolioBreakdown();
  useHashScroll(!!data && !!breakdown);

  // ── Account Details order (drag and drop, saved per account) ──────────────
  const savedOrder = useUiPrefsStore((st) => st.portfolioSectionOrder);
  const setSavedOrder = useUiPrefsStore((st) => st.setPortfolioSectionOrder);
  const sectionOrder = useMemo(() => resolveSectionOrder(savedOrder), [savedOrder]);
  const orderCustomized = savedOrder !== null && sectionOrder.join() !== SECTION_ORDER.join();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onSectionDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    // Move within the full order, so empty (hidden) sections keep their place.
    const from = sectionOrder.indexOf(active.id as SectionId);
    const to = sectionOrder.indexOf(over.id as SectionId);
    if (from < 0 || to < 0) return;
    setSavedOrder(arrayMove(sectionOrder, from, to));
  }

  // ── Include / exclude an asset from net worth, straight from these tables ────
  const qc = useQueryClient();
  const { data: assets } = useAssets();
  const updateAsset = useUpdateAsset();

  const refreshPortfolio = () => qc.invalidateQueries({ queryKey: ["portfolio"] });

  // Assets (property / other assets) store the flag inside metadata_json — merge
  // so we don't drop sibling keys (thumbnails, notes, …).
  function toggleAssetExclude(id: number, nextExcluded: boolean) {
    const asset = assets?.find((a) => a.id === id);
    const meta: Record<string, unknown> = { ...(asset?.metadata_json ?? {}) };
    if (nextExcluded) meta.exclude_from_net_worth = true;
    else delete meta.exclude_from_net_worth;
    updateAsset.mutate({ id, metadata_json: meta }, { onSuccess: refreshPortfolio });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const gainColor = data.total_gain >= 0 ? "text-success" : "text-destructive";

  const bd = breakdown;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <AddAccountButton />
      </div>

      {/* Net worth trend */}
      <NetWorthTrendChart />

      {/* Hero stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Net Worth" value={formatCurrency(data.net_worth)} to="#account-details" />
        <Stat label="Total Assets" value={formatCurrency(data.total_assets)} to="#account-details" />
        <Stat label="Total Liabilities" value={formatCurrency(data.total_liabilities)} color="text-destructive" to="#liabilities" />
        <Stat
          to="/investments/stocks"
          label="Investment Gain/Loss"
          value={`${data.total_gain >= 0 ? "+" : ""}${formatCurrency(data.total_gain)}`}
          sub={
            data.costed_value > 0
              ? `On ${formatCurrency(data.costed_value)} with cost basis ${formatCurrency(data.total_cost_basis)}`
              : "No cost basis on file"
          }
          color={gainColor}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        <AssetBreakdownDonut breakdown={data.asset_breakdown} total={data.total_assets} />
        <FeeAnalysisCard fee={data.fee_analysis} />

        {/* Non-investment assets and debts — these used to sit inside Fee
            Analysis, which made the card read as if loans were a fee. */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3 lg:col-span-2 xl:col-span-1">
          <h2 className="text-sm font-medium text-muted-foreground">Assets &amp; Debts</h2>
          {[
            { label: "Cash", value: data.total_cash, to: "#section-cash" },
            { label: "Investments", value: data.investment_value, to: "#section-investments" },
            { label: "Property", value: data.property_value, to: "/investments/property" },
            { label: "Other assets", value: data.other_asset_value, to: "/investments/other" },
            {
              to: "#liabilities",
              label: "Outstanding loans",
              // Asset-backed loans plus standalone loan/mortgage accounts —
              // showing only the former read as $0 whenever the debt came
              // from a linked or manually added loan account.
              value: data.total_loan_balance + data.total_loan_account_balance,
              debt: true,
            },
            { label: "Credit cards", value: Math.abs(data.total_cc_balance), debt: true, to: "#section-credit-cards" },
          ].map((row) => (
            <Link
              key={row.label}
              to={row.to}
              className="group flex items-center justify-between text-sm rounded px-1 -mx-1 py-0.5 hover:bg-muted/60"
            >
              <span className="text-muted-foreground group-hover:text-foreground">{row.label}</span>
              <span className={cn("font-medium tabular-nums", row.debt && row.value > 0 && "text-destructive")}>
                {formatCurrency(row.value)}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* ── Account & Asset breakdown tables ─────────────────────────────── */}
      {bd && (() => {
        const sections: Record<SectionId, { count: number; render: (handle: ReactNode) => ReactNode }> = {
          cash: {
            count: bd.cash.length,
            render: (handle) => (
              <SectionTable
                id="cash"
                dragHandle={handle}
                title="Cash & Bank Accounts"
                count={bd.cash.length}
                total={bd.cash.reduce((s, r) => s + (r.balance ?? 0), 0)}
                totalLabel="Total Balance"
                pctOf={data.total_assets}
              >
                <AccountTable rows={bd.cash} amountKey="balance" amountLabel="Balance" />
              </SectionTable>
            ),
          },
          investments: {
            count: bd.investments.length,
            render: (handle) => (
              <SectionTable
                id="investments"
                dragHandle={handle}
                title="Investments"
                count={bd.investments.length}
                total={bd.investments.filter((r) => !r.excluded).reduce((s, r) => s + (r.value ?? 0), 0)}
                totalLabel="Total Value"
                pctOf={data.total_assets}
              >
                <AccountTable rows={bd.investments} amountKey="value" amountLabel="Market Value" />
              </SectionTable>
            ),
          },
          "credit-cards": {
            count: bd.credit_cards.length,
            render: (handle) => (
              <SectionTable
                id="credit-cards"
                dragHandle={handle}
                title="Credit Cards"
                count={bd.credit_cards.length}
                total={bd.credit_cards.reduce((s, r) => s + Math.abs(r.balance ?? 0), 0)}
                totalLabel="Total Owed"
                pctOf={data.total_liabilities}
              >
                <AccountTable rows={bd.credit_cards} amountKey="balance" amountLabel="Balance Owed" negate />
              </SectionTable>
            ),
          },
          loans: {
            count: bd.loans.length,
            render: (handle) => (
              <SectionTable
                id="loans"
                dragHandle={handle}
                title="Loans"
                count={bd.loans.length}
                total={bd.loans.reduce((s, r) => s + Math.abs(r.balance ?? 0), 0)}
                totalLabel="Total Owed"
                pctOf={data.total_liabilities}
              >
                <AccountTable rows={bd.loans} amountKey="balance" amountLabel="Balance Owed" negate />
              </SectionTable>
            ),
          },
          property: {
            count: bd.mortgages.length,
            render: (handle) => (
              <SectionTable
                id="property"
                dragHandle={handle}
                title="Property"
                count={bd.mortgages.length}
                total={bd.mortgages.reduce((s, r) => s + (r.property_value ?? r.value ?? 0), 0)}
                totalLabel="Total Value"
                pctOf={data.total_assets}
              >
                <AssetTable rows={bd.mortgages} showLoan onToggleExclude={toggleAssetExclude} href="/investments/property" />
              </SectionTable>
            ),
          },
          "other-assets": {
            count: bd.other_assets.length,
            render: (handle) => (
              <SectionTable
                id="other-assets"
                dragHandle={handle}
                title="Other Assets"
                count={bd.other_assets.length}
                total={bd.other_assets.reduce((s, r) => s + (r.value ?? 0), 0)}
                totalLabel="Total Value"
                pctOf={data.total_assets}
              >
                <AssetTable rows={bd.other_assets} showLoan={bd.other_assets.some((r) => r.loan_balance > 0)} onToggleExclude={toggleAssetExclude} href="/investments/other" />
              </SectionTable>
            ),
          },
        };
        // Empty sections render nothing, so they aren't drag targets either.
        const visible = sectionOrder.filter((id) => sections[id].count > 0);

        return (
          <div id="account-details" className="space-y-3 scroll-mt-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-muted-foreground uppercase tracking-wide text-xs">Account Details</h2>
              {orderCustomized ? (
                <button
                  type="button"
                  onClick={() => setSavedOrder(null)}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw size={12} /> Reset order
                </button>
              ) : (
                <span className="hidden sm:inline text-xs text-muted-foreground">
                  Drag <GripVertical size={12} className="inline -mt-0.5" /> to reorder
                </span>
              )}
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSectionDragEnd}>
              <SortableContext items={visible} strategy={verticalListSortingStrategy}>
                <div className="space-y-3">
                  {visible.map((id) => (
                    <SortableSection key={id} id={id}>
                      {(handle) => sections[id].render(handle)}
                    </SortableSection>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        );
      })()}
    </div>
  );
}
