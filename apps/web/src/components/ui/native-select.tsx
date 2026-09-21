import type * as React from "react";
import { useHydrationGate } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

/** Normal-density select with the phone touch floor from DESIGN.md. */
export function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  const gate = useHydrationGate(props.disabled);
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-11 rounded-md border border-input bg-card px-2.5 text-sm max-sm:text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 md:h-9 md:text-xs",
        className,
      )}
      {...props}
      {...gate}
    />
  );
}
