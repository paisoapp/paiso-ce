import { cn } from "@/lib/utils";

type Variant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

const variants: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  outline: "border border-border text-foreground bg-transparent",
  success: "bg-success/20 text-success",
  warning: "bg-warning/20 text-warning",
};

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export function Badge({ variant = "default", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
