import * as React from "react";

import { useHydrationGate } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  const gate = useHydrationGate(props.disabled);
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-border bg-input/20 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 aria-invalid:border-destructive placeholder:text-muted-foreground flex field-sizing-content min-h-16 max-sm:min-h-24 w-full resize-none rounded-none border px-2 py-2 text-sm max-sm:text-base transition-colors outline-none focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[2px] md:text-xs/relaxed",
        gate["data-hydrating"] !== undefined && "disabled:opacity-100",
        className,
      )}
      {...props}
      {...gate}
    />
  );
}

export { Textarea };
