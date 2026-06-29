import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * A ruled surface primitive for the Warm-Paper Ledger look: paper fill +
 * hairline border, square corners, separation by rule and tone (never
 * elevation). Centralizes the lifted/rounded/shadowed surface styling that was
 * being hand-rolled per component. `Card` stays the canonical bordered content
 * card; `Surface` is the lower-level primitive for the other named surfaces.
 *
 * Polymorphic via `as`. One axis (`variant`); use `className` for sizing/layout.
 */
const surfaceVariants = cva("rounded-none", {
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

export { surfaceVariants };
