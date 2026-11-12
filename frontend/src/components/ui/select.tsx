import { cn } from "@/lib/utils";

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export function Select({ label, error, className, id, ...props }: SelectProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
      )}
      <select
        id={id}
        className={cn(
          "rounded-md border border-border bg-background px-3 py-2 min-h-[40px] text-base md:text-sm text-foreground",
          "focus:outline-none focus:ring-2 focus:ring-primary/50",
          "disabled:opacity-50",
          error && "border-destructive",
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
