import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

// Warm-Paper Ledger: badges read as rubber stamps — a hairline border + a
// quiet tint fill, square corners, no saturated pills. Tint comes from
// color-mixing the tone ~12% into paper so it sits on the ledger, not over it.
const badgeVariants = cva(
  "h-5 gap-1 rounded-none border px-1.5 py-0.5 text-2xs font-mono font-medium uppercase tracking-wider transition-all has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:size-2.5! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive transition-colors overflow-hidden group/badge",
  {
    variants: {
      variant: {
        default:
          "border-primary/40 bg-primary/10 text-primary [a]:hover:bg-primary/20",
        secondary:
          "border-[var(--border)] bg-secondary text-secondary-foreground [a]:hover:bg-[var(--brand-hairline)]",
        destructive:
          "border-destructive/30 bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 text-destructive",
        positive:
          "border-positive/30 bg-positive/10 [a]:hover:bg-positive/20 text-positive",
        warning:
          "border-warning/30 bg-warning/10 [a]:hover:bg-warning/20 text-warning",
        plum: "border-plum/30 bg-plum/10 [a]:hover:bg-plum/20 text-plum",
        slate:
          "border-slate/40 bg-slate/10 [a]:hover:bg-slate/20 text-slate",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground bg-input/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ className, variant })),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

/** The tone names accepted by `<Badge variant>` — reuse for per-enum tone maps. */
export type BadgeVariant = NonNullable<
  VariantProps<typeof badgeVariants>["variant"]
>;

export { Badge, badgeVariants };
