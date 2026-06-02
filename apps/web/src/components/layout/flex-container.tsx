import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  type FlexContainerVariants,
  flexContainerVariants,
} from "~/styles/layouts";

interface FlexContainerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    FlexContainerVariants {}

export const FlexContainer = ({
  className,
  align,
  justify,
  gap,
  ref,
  ...props
}: FlexContainerProps & { ref?: React.Ref<HTMLDivElement> }) => {
  return (
    <div
      className={cn(flexContainerVariants({ align, justify, gap }), className)}
      ref={ref}
      {...props}
    />
  );
};

FlexContainer.displayName = "FlexContainer";
