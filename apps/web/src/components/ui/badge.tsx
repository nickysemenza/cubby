import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

// Compact statuses pair text with a quiet tinted chip. Domain color remains a
// separate wayfinding channel and is never substituted for status meaning.
const badgeVariants = cva(
  "h-5 gap-1 rounded-full border px-1.5 py-0.5 text-2xs font-medium transition-colors duration-150 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:size-2.5! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[2px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive overflow-hidden group/badge",
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
          "border-warning/30 bg-warning/10 [a]:hover:bg-warning/20 text-warning-ink",
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

/**
 * The same tone, as the tint for `<EnumPill color>`.
 *
 * Exists so a table cell can render an enum as a quiet tinted pill while
 * reusing the tone map its Badge already had. The alternative was re-picking a
 * colour per enum by hand, which would have let the list and the detail page
 * drift apart on the same value.
 *
 * `secondary` and `outline` carry no tone of their own, so they land on the
 * neutral ink: a roster where every option is untoned gets uniform pills by
 * design, and the label carries the distinction.
 */
export const badgeVariantColor: Record<BadgeVariant, string> = {
  default: "var(--primary)",
  secondary: "var(--slate)",
  destructive: "var(--destructive)",
  positive: "var(--positive)",
  warning: "var(--warning)",
  plum: "var(--plum)",
  slate: "var(--slate)",
  outline: "var(--slate)",
};

export { Badge, badgeVariants };
