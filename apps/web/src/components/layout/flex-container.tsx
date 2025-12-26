import * as React from "react";
import { cn } from "~/lib/utils";
import {
  flexContainerVariants,
  type FlexContainerVariants,
} from "~/styles/layouts";

interface FlexContainerProps
  extends React.HTMLAttributes<HTMLDivElement>, FlexContainerVariants {}

export const FlexContainer = React.forwardRef<
  HTMLDivElement,
  FlexContainerProps
>(({ className, direction, align, justify, gap, ...props }, ref) => {
  return (
    <div
      className={cn(
        flexContainerVariants({ direction, align, justify, gap }),
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

FlexContainer.displayName = "FlexContainer";
