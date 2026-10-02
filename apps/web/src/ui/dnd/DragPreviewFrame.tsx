import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export function DragPreviewFrame({
  className,
  valid = true,
  ...props
}: ComponentProps<"div"> & { valid?: boolean }) {
  return (
    <div
      data-valid={valid || undefined}
      data-invalid={!valid || undefined}
      className={cn(
        "pointer-events-none border bg-card text-card-foreground outline-none",
        "data-valid:border-primary data-valid:bg-primary/5",
        "data-invalid:border-destructive data-invalid:bg-destructive/10",
        "motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}
