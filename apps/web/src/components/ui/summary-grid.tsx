import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const summaryGridVariants = cva("grid", {
  variants: {
    variant: {
      default: "grid-cols-4 gap-4 md:grid-cols-8",
      compact: "grid-cols-2 gap-2 md:grid-cols-4",
      wide: "grid-cols-6 gap-4 md:grid-cols-12",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface SummaryGridProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof summaryGridVariants> {}

export const SummaryGrid = React.forwardRef<HTMLDivElement, SummaryGridProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <div
        className={cn(summaryGridVariants({ variant }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);

SummaryGrid.displayName = "SummaryGrid";
