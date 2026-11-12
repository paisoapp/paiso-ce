import { Component, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CardTitle, clickableCardClass } from "@/components/ui/card-link";
import { useCardClick } from "@/lib/navTargets";
import { cn } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";

/** Charts pick their own palette steps per surface; dark is chosen, not inverted. */
export function useChartDark(): boolean {
  return useIsDarkMode();
}

export const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  opacity: 0.97,
};

/** Standard widget chrome: a card that fills its grid cell. With `to`, the
 *  whole card opens that page (its title is the keyboard-reachable link). */
export function WidgetCard({
  title,
  to,
  headerExtra,
  children,
  className,
}: {
  title: string;
  to?: string;
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const onClick = useCardClick(to);
  return (
    <div
      onClick={to ? onClick : undefined}
      className={cn("h-full rounded-xl border border-border bg-card p-4 flex flex-col", to && clickableCardClass, className)}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <CardTitle title={title} to={to} />
        {headerExtra && <div className="flex items-center gap-2 shrink-0">{headerExtra}</div>}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

export function WidgetSkeleton({ className }: { className?: string }) {
  return <div className={cn("h-full min-h-24 rounded-xl bg-muted animate-pulse", className)} />;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-32 flex items-center justify-center text-center text-sm text-muted-foreground px-4">
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent,
  to,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  accent?: string;
  /** A stat card holds nothing interactive, so with `to` it is one link. */
  to?: string;
}) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold mt-1 tabular-nums", accent ?? "text-foreground")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </>
  );
  const cls = "block h-full rounded-xl border border-border bg-card px-5 py-4";
  return to ? (
    <Link to={to} className={cn(cls, clickableCardClass)}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Keeps one broken widget from blanking the whole dashboard. */
export class WidgetErrorBoundary extends Component<
  { title: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`Dashboard widget "${this.props.title}" failed`, error);
  }

  render() {
    if (this.state.failed) {
      return (
        <WidgetCard title={this.props.title}>
          <EmptyState>This widget could not load.</EmptyState>
        </WidgetCard>
      );
    }
    return this.props.children;
  }
}
