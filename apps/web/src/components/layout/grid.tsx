import type * as React from "react";

import { cn } from "~/lib/utils";
import { type GridVariants, gridVariants } from "~/styles/layouts";

interface GridProps extends React.HTMLAttributes<HTMLElement>, GridVariants {
  /** Render as a different element (e.g. "ul"). */
  as?: React.ElementType;
  ref?: React.Ref<HTMLElement>;
}

/**
 * Responsive grid — use a `cols` preset (cards3 / thumbs / images / summary)
 * for the common layouts; pass a custom `grid-cols-[…]` via className otherwise.
 */
export const Grid = ({
  as: Comp = "div",
  className,
  cols,
  gap,
  ref,
  ...props
}: GridProps) => {
  return (
    <Comp
      className={cn(gridVariants({ cols, gap }), className)}
      ref={ref}
      {...props}
    />
  );
};

Grid.displayName = "Grid";
