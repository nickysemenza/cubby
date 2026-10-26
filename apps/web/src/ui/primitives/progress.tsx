import { Progress as BaseProgress } from "@base-ui/react/progress";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

type ProgressProps = Omit<ComponentProps<typeof BaseProgress.Root>, "value" | "className"> & {
  value?: number | null;
  indeterminate?: boolean;
  paused?: boolean;
  className?: string;
};

/** ReUI's Base UI composition: label/value above one token-styled track. */
export function Progress({
  value = 0,
  max = 100,
  indeterminate = false,
  paused = false,
  className,
  children,
  ...props
}: ProgressProps) {
  const total = Number.isFinite(max) && max > 0 ? max : 1;
  const current = indeterminate || value === null
    ? null
    : Math.min(total, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <BaseProgress.Root
      data-slot="progress"
      value={current}
      max={total}
      className={cn("grid w-full min-w-0 grid-cols-[1fr_auto] gap-x-2 gap-y-1", className)}
      {...props}
    >
      {children}
      <BaseProgress.Track data-slot="progress-track" className="col-span-2 h-1.5 overflow-hidden bg-muted">
        <BaseProgress.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full motion-safe:transition-[width] motion-safe:duration-300",
            paused ? "bg-primary/45" : "bg-primary",
            current === null && "progress-indeterminate w-1/3",
          )}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}

export function ProgressLabel({ className, ...props }: ComponentProps<typeof BaseProgress.Label>) {
  return <BaseProgress.Label data-slot="progress-label" className={cn("min-w-0 text-xs text-muted-foreground max-sm:col-span-2", className)} {...props} />;
}

export function ProgressValue({ className, ...props }: ComponentProps<typeof BaseProgress.Value>) {
  return <BaseProgress.Value data-slot="progress-value" className={cn("font-mono text-xs text-muted-foreground max-sm:col-span-2", className)} {...props} />;
}
