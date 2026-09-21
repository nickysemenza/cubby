import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { useHydrationGate } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const gate = useHydrationGate(props.disabled);
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "bg-card border-border focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 aria-invalid:border-destructive file:text-foreground placeholder:text-muted-foreground h-9 max-sm:h-11 w-full min-w-0 rounded-sm border px-2.5 py-1 text-sm max-sm:text-base transition-colors duration-150 outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-xs/relaxed file:font-medium focus-visible:ring-[2px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:ring-[2px] md:text-xs/relaxed",
        gate["data-hydrating"] !== undefined &&
          "disabled:bg-card disabled:opacity-100",
        className,
      )}
      {...props}
      {...gate}
    />
  );
}

export { Input };
