import type * as React from "react";
import { cn } from "~/lib/utils";

/** Compact desktop native select with the phone touch floor from DESIGN.md. */
export function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-10 rounded-none border border-input bg-input/20 px-2 text-xs focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7",
        className,
      )}
      {...props}
    />
  );
}
