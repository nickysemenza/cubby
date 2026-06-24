import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Semantic status-colored text — the canonical replacement for standalone
 * `text-positive | text-warning | text-destructive` text (tier labels, deltas,
 * inline status). One axis (`tone`); maps to the design tokens.
 */
const statusTextVariants = cva("", {
  variants: {
    tone: {
      positive: "text-positive",
      warning: "text-warning",
      destructive: "text-destructive",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: { tone: "muted" },
});

interface StatusTextProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof statusTextVariants> {
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}

export const StatusText = ({
  as: Comp = "span",
  tone,
  className,
  ref,
  ...props
}: StatusTextProps) => (
  <Comp
    className={cn(statusTextVariants({ tone }), className)}
    ref={ref}
    {...props}
  />
);

StatusText.displayName = "StatusText";
