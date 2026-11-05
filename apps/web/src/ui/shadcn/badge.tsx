// Source: ReUI @reui/badge, base-mira.
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "cn"
import { pillVariants } from "~/ui/text/pill"

const badgeVariants = cva(
  [
    pillVariants({ mode: "value" }),
    "transition-colors duration-150 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:size-2.5! relative inline-flex shrink-0 items-center justify-center w-fit border border-transparent font-medium whitespace-nowrap outline-none transition-shadow",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3",
  ],
  {
    variants: {
      variant: {
        default: "border-primary/40 bg-primary/10 text-primary [a]:hover:bg-primary/20",
        outline: "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground bg-input/20",
        secondary: "border-[var(--border)] bg-secondary text-secondary-foreground [a]:hover:bg-[var(--brand-hairline)]",
        info: "bg-info text-white",
        success: "bg-success text-white",
        warning: "border-warning/30 bg-warning/10 [a]:hover:bg-warning/20 text-warning-ink",
        destructive: "border-destructive/30 bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 text-destructive",
        positive: "border-positive/30 bg-positive/10 [a]:hover:bg-positive/20 text-positive",
        plum: "border-plum/30 bg-plum/10 [a]:hover:bg-plum/20 text-plum",
        slate: "border-slate/40 bg-slate/10 [a]:hover:bg-slate/20 text-slate",
        focus: "bg-focus text-focus-foreground",
        invert: "bg-invert text-invert-foreground",
        "primary-light":
          "border-primary/10 bg-primary/10 text-primary",
        "warning-light":
          "border-warning/15 bg-warning/10 text-warning-foreground",
        "success-light":
          "border-success/15 bg-success/10 text-success-foreground",
        "info-light":
          "border-info/15 bg-info/10 text-info-foreground",
        "destructive-light":
          "border-destructive/15 bg-destructive/10 text-destructive-foreground",
        "invert-light":
          "border-invert/15 bg-invert/10 text-foreground",
        "focus-light":
          "border-focus/15 bg-focus/10 text-focus-foreground",
        "primary-outline":
          "bg-background border-border text-primary",
        "warning-outline":
          "bg-background border-border text-warning-foreground",
        "success-outline":
          "bg-background border-border text-success-foreground",
        "info-outline":
          "bg-background border-border text-info-foreground",
        "destructive-outline":
          "bg-background border-border text-destructive-foreground",
        "invert-outline":
          "bg-background border-border text-invert-foreground",
        "focus-outline":
          "bg-background border-border text-focus-foreground",
      },
      size: {
        xs: "px-1 py-0.25 text-3xs leading-none h-4 min-w-4 gap-1",
        sm: "px-1 py-0.25 text-2xs leading-none h-4.5 min-w-4.5 gap-1",
        default: "",
        lg: "px-1.5 py-0.5 text-xs h-5.5 min-w-5.5 gap-1",
        xl: "px-2 py-0.75 text-sm h-6 min-w-6 gap-1.5",
      },
      /** `default`: active style radius. `full`: pill radius. */
      radius: {
        default: "",
        full: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      radius: "default",
    },
  }
)

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"]
  size?: VariantProps<typeof badgeVariants>["size"]
  radius?: VariantProps<typeof badgeVariants>["radius"]
}

function Badge({
  className,
  variant,
  size,
  radius,
  render,
  ...props
}: BadgeProps) {
  const defaultProps = {
    "data-slot": "badge",
    className: cn(badgeVariants({ variant, size, radius, className })),
  }

  return useRender({
    defaultTagName: "span",
    render,
    props: mergeProps<"span">(defaultProps, props),
    state: { slot: "badge", variant: variant ?? "default" },
  })
}

/** The tone names accepted by `<Badge variant>` — reuse for per-enum tone maps. */
export type BadgeVariant = "default" | "secondary" | "destructive" | "positive" | "warning" | "plum" | "slate" | "outline";

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


export { Badge, badgeVariants, type BadgeProps }