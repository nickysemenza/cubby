import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * A low-level Porcelain Transit surface. `Card` remains the canonical content
 * panel; `Surface` covers detail plates and other named structural regions.
 *
 * Polymorphic via `as`. One axis (`variant`); use `className` for sizing/layout.
 */
const surfaceVariants = cva("rounded-lg", {
  variants: {
    variant: {
      /** The detail "spec plate" placard — subtly inset tone. */
      specPlate: "bg-muted/40 border border-[var(--border)]",
    },
  },
  defaultVariants: { variant: "specPlate" },
});

export interface SurfaceProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof surfaceVariants> {
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}

export const Surface = ({
  as: Comp = "div",
  variant,
  className,
  ref,
  ...props
}: SurfaceProps) => (
  <Comp
    data-slot="surface"
    className={cn(surfaceVariants({ variant }), className)}
    ref={ref}
    {...props}
  />
);
Surface.displayName = "Surface";

;
