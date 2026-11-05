import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cn } from "cn"

function Progress({
  className,
  children,
  value = 0,
  max = 100,
  indeterminate = false,
  paused = false,
  ...props
}: Omit<ProgressPrimitive.Root.Props, "value"> & { value?: number | null; indeterminate?: boolean; paused?: boolean }) {
  const total = Number.isFinite(max) && max > 0 ? max : 1
  const current = indeterminate || value === null ? null : Math.min(total, Math.max(0, Number.isFinite(value) ? value : 0))
  return (
    <ProgressPrimitive.Root
      value={current}
      max={total}
      data-slot="progress"
      className={cn("grid w-full min-w-0 grid-cols-[1fr_auto] gap-x-2 gap-y-1", className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator className={cn(paused ? "bg-primary/45" : "bg-primary", current === null && "progress-indeterminate w-1/3")} />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        "col-span-2 h-1.5 overflow-hidden bg-muted",
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  )
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn("h-full motion-safe:transition-[width] motion-safe:duration-300", className)}
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("min-w-0 text-xs text-muted-foreground max-sm:col-span-2", className)}
      data-slot="progress-label"
      {...props}
    />
  )
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        "font-mono text-xs text-muted-foreground max-sm:col-span-2",
        className
      )}
      data-slot="progress-value"
      {...props}
    />
  )
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
}
