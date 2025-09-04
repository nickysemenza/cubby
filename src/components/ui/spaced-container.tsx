import * as React from "react";
import { cn } from "~/lib/utils";
import {
  spacedContainerVariants,
  type SpacedContainerVariants,
} from "~/styles/layouts";

export interface SpacedContainerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    SpacedContainerVariants {}

export const SpacedContainer = React.forwardRef<
  HTMLDivElement,
  SpacedContainerProps
>(({ className, space, ...props }, ref) => {
  return (
    <div
      className={cn(spacedContainerVariants({ space }), className)}
      ref={ref}
      {...props}
    />
  );
});

SpacedContainer.displayName = "SpacedContainer";
