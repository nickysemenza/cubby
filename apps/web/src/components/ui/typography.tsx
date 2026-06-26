import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * Typography helpers beyond {@link Eyebrow} / {@link Description}, for the dense
 * data surfaces (tables, spec plates, metric readouts) that were reaching for
 * ad-hoc `text-2xs` / `font-mono` / `tabular-nums` strings. All map onto the
 * Warm-Paper Ledger tokens (JetBrains Mono via `font-mono`, `--slate`,
 * `--muted-foreground`). One axis each; reach for `className` for anything else.
 */

/**
 * A numeric / data value rendered in the mono substrate with lining,
 * tabular figures so columns of numbers align. Replaces inline
 * `font-mono tabular-nums` on prices, counts, ids, metrics.
 */
const monoValueVariants = cva("font-mono tabular-nums", {
  variants: {
    size: { sm: "text-sm", xs: "text-xs", base: "text-base" },
    tone: { default: "", muted: "text-muted-foreground", strong: "font-medium" },
  },
  defaultVariants: { size: "sm", tone: "default" },
});

interface MonoValueProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof monoValueVariants> {
  as?: React.ElementType;
  ref?: React.Ref<HTMLSpanElement>;
}

export const MonoValue = ({
  as: Comp = "span",
  size,
  tone,
  className,
  ref,
  ...props
}: MonoValueProps) => (
  <Comp
    className={cn(monoValueVariants({ size, tone }), className)}
    ref={ref}
    {...props}
  />
);
MonoValue.displayName = "MonoValue";

/**
 * The uppercase mono micro-label used for table column heads and dense field
 * labels (the same look as the `eyebrow` utility, scoped smaller). Renders a
 * `<span>` by default; pass `as="th"` / `as="label"` as needed.
 */
export const TableLabel = ({
  as: Comp = "span",
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}) => (
  <Comp
    className={cn(
      "font-mono text-2xs text-slate uppercase tracking-wider",
      className,
    )}
    ref={ref}
    {...props}
  />
);
TableLabel.displayName = "TableLabel";

/**
 * A small caption — figure captions, helper notes under a value. Slightly
 * smaller than {@link Description}; not muted by default so it reads as content.
 */
export const Caption = ({
  as: Comp = "p",
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement> & {
  as?: React.ElementType;
  ref?: React.Ref<HTMLParagraphElement>;
}) => (
  <Comp className={cn("text-xs leading-snug", className)} ref={ref} {...props} />
);
Caption.displayName = "Caption";

/**
 * Dense secondary metadata — the tiny muted mono line under a row title (counts,
 * timestamps, ids). Replaces scattered `text-2xs text-muted-foreground`.
 */
export const DenseMeta = ({
  as: Comp = "span",
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  as?: React.ElementType;
  ref?: React.Ref<HTMLSpanElement>;
}) => (
  <Comp
    className={cn("text-2xs text-muted-foreground", className)}
    ref={ref}
    {...props}
  />
);
DenseMeta.displayName = "DenseMeta";
