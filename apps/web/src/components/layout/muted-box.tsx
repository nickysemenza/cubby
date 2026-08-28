import type * as React from "react";
import { cn } from "~/lib/utils";

interface MutedBoxProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md";
}

const paddingClasses = { sm: "p-2", md: "p-4" };

export const MutedBox = ({
  padding = "md",
  className,
  ref,
  ...props
}: MutedBoxProps & { ref?: React.Ref<HTMLDivElement> }) => (
  <div
    data-slot="surface"
    className={cn(
      "rounded-lg border border-[var(--border)] bg-muted/40",
      paddingClasses[padding],
      className,
    )}
    ref={ref}
    {...props}
  />
);

MutedBox.displayName = "MutedBox";
