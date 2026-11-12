import { cn } from "@/lib/utils";

/**
 * Table→card scaffolding for mobile. Renders `table` at md+ and `cards`
 * below md, CSS-only so there is no flash on load. Pages hand-write their
 * card content with MobileRowCard/MobileRowMeta; for very long lists prefer
 * useIsMobile() and render only one branch to avoid double-rendering rows.
 */
export function ResponsiveList({
  table,
  cards,
  className,
}: {
  table: React.ReactNode;
  cards: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="hidden md:block">{table}</div>
      <div className="md:hidden">{cards}</div>
    </div>
  );
}

/**
 * Standard mobile row card: title/subtitle left, primary value right,
 * optional label:value detail grid and action row underneath.
 */
export function MobileRowCard({
  title,
  subtitle,
  value,
  valueClassName,
  meta,
  actions,
  onClick,
  selected,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: React.ReactNode;
  valueClassName?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={cn(
        "w-full rounded-lg border border-border bg-card p-3 text-left",
        onClick && "active:bg-accent transition-colors",
        selected && "border-primary bg-primary/5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground truncate">{title}</div>
          {subtitle && (
            <div className="text-xs text-muted-foreground truncate mt-0.5">{subtitle}</div>
          )}
        </div>
        {value !== undefined && (
          <div className={cn("text-sm font-semibold text-right shrink-0", valueClassName)}>
            {value}
          </div>
        )}
      </div>
      {meta && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">{meta}</div>
      )}
      {actions && (
        <div className="mt-2 flex items-center gap-2 justify-end">{actions}</div>
      )}
    </Tag>
  );
}

/** A label:value pair for the MobileRowCard detail grid. */
export function MobileRowMeta({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-2 text-xs", className)}>
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground text-right truncate">{children}</span>
    </div>
  );
}
