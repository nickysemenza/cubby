import type * as React from "react";

import { cn } from "~/lib/utils";
import { type RowVariants, rowVariants } from "~/styles/layouts";

interface RowProps extends React.HTMLAttributes<HTMLElement>, RowVariants {
  /** Render as a different element (e.g. "ul", "nav", "label", "button"). */
  as?: React.ElementType;
  /** Forwarded when `as="button"`. */
  type?: "button" | "submit" | "reset";
  /** Forwarded when `as="button"`/`as="fieldset"`. */
  disabled?: boolean;
  ref?: React.Ref<HTMLElement>;
}

/**
 * Horizontal flex row — the canonical replacement for `flex items-center gap-*`.
 * No defaults: a bare `<Row>` is just `flex`; opt into `align`/`justify`/`gap`.
 */
export const Row = ({
  as: Comp = "div",
  className,
  align,
  justify,
  wrap,
  gap,
  ref,
  ...props
}: RowProps) => {
  return (
    <Comp
      className={cn(rowVariants({ align, justify, wrap, gap }), className)}
      ref={ref}
      {...props}
    />
  );
};

Row.displayName = "Row";
