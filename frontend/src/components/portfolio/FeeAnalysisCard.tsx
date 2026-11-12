import { Link } from "react-router-dom";
import { CardTitle, clickableCardClass } from "@/components/ui/card-link";
import { AlertTriangle, Info } from "@/lib/icons";
import type { FeeAnalysis } from "@/hooks/usePortfolio";
import { useCardClick } from "@/lib/navTargets";
import { formatCurrency, cn } from "@/lib/utils";

const HIGH_ER_PCT = 0.5;

/**
 * Fund fees across holdings.
 *
 * The weighted ratio is taken over funds whose ratio is known; coverage says
 * how much of the fee-bearing value that is, so a figure built on a sliver of
 * the portfolio never passes for the whole picture.
 */
export function FeeAnalysisCard({ fee, className, to }: { fee: FeeAnalysis; className?: string; to?: string }) {
  const onCardClick = useCardClick(to);
  const hasFunds = fee.fee_bearing_value > 0;
  const hasKnown = fee.er_known_value > 0;
  const high = hasKnown && fee.weighted_expense_ratio > HIGH_ER_PCT;

  return (
    <div
      id="fee-analysis"
      onClick={to ? onCardClick : undefined}
      className={cn("rounded-xl border border-border bg-card p-4 space-y-4 scroll-mt-4", to && clickableCardClass, className)}
    >
      <CardTitle title="Fee Analysis" to={to} />

      {!hasFunds ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No funds or securities yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Metric
              label="Weighted expense ratio"
              value={hasKnown ? `${fee.weighted_expense_ratio.toFixed(3)}%` : "—"}
            />
            <Metric label="Annual fees" value={hasKnown ? formatCurrency(fee.annual_fee) : "—"} />
            <Metric
              label={`Cost over ${fee.projection_years} yrs`}
              value={hasKnown ? formatCurrency(fee.projected_fee_cost) : "—"}
              hint={`Growth given up versus the same portfolio with no fund fees, assuming ${fee.projection_growth_pct}% a year. An illustration, not a forecast.`}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Expense ratio known for {formatCurrency(fee.er_known_value)} of {formatCurrency(fee.fee_bearing_value)}
              </span>
              <span className="tabular-nums font-medium">{fee.coverage_pct.toFixed(0)}%</span>
            </div>
            <div
              className="h-1.5 rounded-full bg-muted overflow-hidden"
              role="progressbar"
              aria-valuenow={fee.coverage_pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Expense ratio coverage"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, fee.coverage_pct)}%` }} />
            </div>
            {fee.unknown_fund_count > 0 && (
              <p className="text-xs text-muted-foreground">
                {fee.unknown_fund_count} fund{fee.unknown_fund_count === 1 ? "" : "s"}{" "}
                ({formatCurrency(fee.unknown_value)}) with no expense ratio on file, not
                counted above:{" "}
                {/* Named, not just counted. "3 funds, see Investments" left the
                    user to work out which three across every account. */}
                {fee.unknown_funds.map((f, i) => (
                  <span key={`${f.source}-${f.ticker ?? f.name}`}>
                    {i > 0 && ", "}
                    <Link
                      to="/investments/stocks"
                      className="font-medium text-foreground hover:underline"
                      title={f.ticker ? f.name : undefined}
                    >
                      {f.ticker ?? f.name}
                    </Link>
                  </span>
                ))}
                {fee.unknown_fund_count > fee.unknown_funds.length &&
                  ` and ${fee.unknown_fund_count - fee.unknown_funds.length} more`}
                . Ratios fill in automatically for listed funds;{" "}
                <Link to="/investments/stocks" className="text-primary hover:underline">
                  add one on Investments
                </Link>.
              </p>
            )}
          </div>

          {fee.top_costs.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Most expensive funds</p>
              <ul className="divide-y divide-border text-sm">
                {fee.top_costs.slice(0, 3).map((r) => (
                  <li key={`${r.source}-${r.ticker ?? r.name}`}>
                    <Link
                      to="/investments/stocks"
                      className="flex items-center gap-2 py-1.5 rounded px-1 -mx-1 hover:bg-muted/60"
                    >
                    <span className="min-w-0 flex-1 truncate" title={r.ticker ? r.name : undefined}>
                      <span className="font-medium">{r.ticker ?? r.name}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground text-xs">{r.expense_ratio.toFixed(2)}%</span>
                    <span className="tabular-nums w-20 text-right">{formatCurrency(r.annual_fee)}/yr</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {high && (
            <div className="flex gap-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={14} className="shrink-0 mt-px" />
              <span>
                Your weighted expense ratio of {fee.weighted_expense_ratio.toFixed(3)}% is above {HIGH_ER_PCT}%.
                Low-cost index funds commonly charge under 0.10%.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      {/* Labels wrap rather than truncate: the card is narrow in the Portfolio's
          3-column grid and a half-word label ("Weighted expe…") says nothing. */}
      <p className="text-[11px] leading-tight text-muted-foreground min-h-[2lh]">
        {label}
        {hint && (
          <span title={hint} className="inline-flex cursor-help align-[-1px] ml-1" aria-label={hint}>
            <Info size={11} />
          </span>
        )}
      </p>
      <p className="text-base sm:text-lg font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}
