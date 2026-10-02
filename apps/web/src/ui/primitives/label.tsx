
import * as React from "react";

import { cn } from "~/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        // Sentence case at every width — labels never uppercase (DESIGN.md:
        // "Labels are sentence case at every width"). Phone gets a slightly
        // larger 13/18 size; desktop is the compact 12/16 control label.
        "flex items-center gap-2 font-sans text-xs/4 font-medium text-foreground select-none max-md:text-[13px]/[18px] group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
