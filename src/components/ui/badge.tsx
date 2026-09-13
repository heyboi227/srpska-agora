import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-border bg-surface-muted text-text-muted",
        ai: "border-ai/40 bg-ai-soft text-ai",
        accent: "border-accent/40 bg-accent-soft text-accent",
        ok: "border-ok/40 bg-transparent text-ok",
        warn: "border-warn/50 bg-transparent text-warn",
        danger: "border-danger/50 bg-transparent text-danger",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
