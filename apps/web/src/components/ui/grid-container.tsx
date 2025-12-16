import * as React from "react";
import { cn } from "~/lib/utils";
import {
  gridContainerVariants,
  type GridContainerVariants,
} from "~/styles/layouts";

export interface GridContainerProps
  extends React.HTMLAttributes<HTMLDivElement>, GridContainerVariants {}

export const GridContainer = React.forwardRef<
  HTMLDivElement,
  GridContainerProps
>(({ className, cols, gap, ...props }, ref) => {
  return (
    <div
      className={cn(gridContainerVariants({ cols, gap }), className)}
      ref={ref}
      {...props}
    />
  );
});

GridContainer.displayName = "GridContainer";
