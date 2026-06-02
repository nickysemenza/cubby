import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  type SpacedContainerVariants,
  spacedContainerVariants,
} from "~/styles/layouts";

interface SpacedContainerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    SpacedContainerVariants {}

export const SpacedContainer = ({
  className,
  space,
  ref,
  ...props
}: SpacedContainerProps & { ref?: React.Ref<HTMLDivElement> }) => {
  return (
    <div
      className={cn(spacedContainerVariants({ space }), className)}
      ref={ref}
      {...props}
    />
  );
};

SpacedContainer.displayName = "SpacedContainer";
