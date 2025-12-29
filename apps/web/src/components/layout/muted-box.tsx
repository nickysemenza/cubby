import * as React from "react";
import { cn } from "~/lib/utils";

interface MutedBoxProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md" | "lg";
}

const paddingClasses = { sm: "p-2", md: "p-4", lg: "p-6" };

export const MutedBox = React.forwardRef<HTMLDivElement, MutedBoxProps>(
  ({ padding = "md", className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-md bg-muted", paddingClasses[padding], className)}
      {...props}
    />
  ),
);

MutedBox.displayName = "MutedBox";
