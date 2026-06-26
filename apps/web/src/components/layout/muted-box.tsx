import type * as React from "react";
import { Surface } from "~/components/ui/surface";
import { cn } from "~/lib/utils";

interface MutedBoxProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md" | "lg";
}

const paddingClasses = { sm: "p-2", md: "p-4", lg: "p-6" };

// Thin wrapper over the Surface `specPlate` variant (muted ruled region). Kept
// as a named layout helper for its padding axis; the surface look itself now
// lives in the shared primitive so it tracks the design system.
export const MutedBox = ({
  padding = "md",
  className,
  ref,
  ...props
}: MutedBoxProps & { ref?: React.Ref<HTMLDivElement> }) => (
  <Surface
    variant="specPlate"
    ref={ref as React.Ref<HTMLElement>}
    className={cn(paddingClasses[padding], className)}
    {...props}
  />
);

MutedBox.displayName = "MutedBox";
