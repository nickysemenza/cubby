import * as React from "react";
import { cn } from "~/lib/utils";
import {
  loadingSpinnerVariants,
  loadingContainerVariants,
  type LoadingSpinnerVariants,
  type LoadingContainerVariants,
} from "~/styles/loading";

export interface LoadingSpinnerProps
  extends
    Omit<React.HTMLAttributes<HTMLDivElement>, "color">,
    LoadingSpinnerVariants {}

export const LoadingSpinner = React.forwardRef<
  HTMLDivElement,
  LoadingSpinnerProps
>(({ className, size, color, ...props }, ref) => {
  return (
    <div
      className={cn(loadingSpinnerVariants({ size, color }), className)}
      ref={ref}
      {...props}
    />
  );
});

LoadingSpinner.displayName = "LoadingSpinner";

export interface LoadingContainerProps
  extends React.HTMLAttributes<HTMLDivElement>, LoadingContainerVariants {
  text?: string;
  spinnerProps?: LoadingSpinnerProps;
}

export const LoadingContainer = React.forwardRef<
  HTMLDivElement,
  LoadingContainerProps
>(
  (
    {
      className,
      justify,
      spacing,
      text = "Loading...",
      spinnerProps,
      ...props
    },
    ref,
  ) => {
    return (
      <div
        className={cn(
          loadingContainerVariants({ justify, spacing }),
          className,
        )}
        ref={ref}
        {...props}
      >
        <LoadingSpinner {...spinnerProps} />
        {text && <span>{text}</span>}
      </div>
    );
  },
);

LoadingContainer.displayName = "LoadingContainer";
