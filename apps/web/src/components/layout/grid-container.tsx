import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  type GridContainerVariants,
  gridContainerVariants,
} from "~/styles/layouts";

interface GridContainerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    GridContainerVariants {}

export const GridContainer = ({
  className,
  cols,
  gap,
  ref,
  ...props
}: GridContainerProps & { ref?: React.Ref<HTMLDivElement> }) => {
  return (
    <div
      className={cn(gridContainerVariants({ cols, gap }), className)}
      ref={ref}
      {...props}
    />
  );
};

GridContainer.displayName = "GridContainer";
