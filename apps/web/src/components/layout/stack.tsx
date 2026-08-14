import type * as React from "react";
import { cn } from "~/lib/utils";
import { type StackVariants, stackVariants } from "~/styles/layouts";

interface StackProps extends React.HTMLAttributes<HTMLElement>, StackVariants {
  /** Render as a different element (e.g. "ul", "section", "button"). */
  as?: React.ElementType;
  /** Forwarded when `as="button"`. */
  type?: "button" | "submit" | "reset";
  /** Forwarded when `as="button"`/`as="fieldset"`. */
  disabled?: boolean;
  ref?: React.Ref<HTMLElement>;
}

/**
 * Vertical stack — the canonical replacement for `space-y-*`. Renders
 * `flex flex-col` + `space-y-*` rather than a plain block `div`: `space-y-*`
 * spaces children with `margin-top`, which inline children (`span`, `a`, …)
 * ignore, so a plain-block stack of two inline elements renders them
 * concatenated on one line with no gap. `flex-col` blockifies every child so
 * the line break actually happens. See `stackVariants` in `~/styles/layouts`
 * for the full trade-off (it stretches an unsized `inline-flex`/`inline-block`
 * child to the container's width, where block layout let it shrink to fit).
 */
export const Stack = ({
  as: Comp = "div",
  className,
  gap,
  ref,
  ...props
}: StackProps) => {
  return (
    <Comp
      className={cn(stackVariants({ gap }), className)}
      ref={ref}
      {...props}
    />
  );
};

Stack.displayName = "Stack";
