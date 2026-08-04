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

/**
 * A status tone that may not apply, for the very common "tint only when
 * something is wrong" case.
 *
 * `StatusText` defaults `tone` to `muted`, which is right for a genuinely
 * secondary value but wrong for a primary number that happens to be fine:
 * `tone={problem ? "warning" : undefined}` silently DIMS the healthy case to
 * the secondary text tier. That is the opposite of the intent every time, and
 * it is invisible to typecheck and to tests that don't assert color — it
 * shipped on the products list's Expected column exactly that way.
 *
 * So: render the tone when there is one, and plain inherited text when there
 * isn't.
 */
export const OptionalStatusText = ({
  tone,
  children,
}: {
  tone: StatusTextProps["tone"] | undefined;
  children: React.ReactNode;
}) => (tone ? <StatusText tone={tone}>{children}</StatusText> : <>{children}</>);

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
