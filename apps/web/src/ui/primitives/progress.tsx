import { cn } from "~/lib/utils";

interface ProgressProps extends React.ComponentProps<"div"> {
  /** Completed units. Ignored when `indeterminate`. */
  value?: number;
  /** Total units (defaults to 100, so `value` reads as a percentage). */
  max?: number;
  /**
   * Show an animated "working…" bar with no fixed fill — for bulk operations
   * whose total isn't known yet. Determinate (value/max) is preferred whenever a
   * count is available.
   */
  indeterminate?: boolean;
  /** Work that holds its place but is not moving now (a waiting step): a lighter fill. */
  paused?: boolean;
}

/**
 * Thin progress bar. Determinate by default (fills to `value / max`); pass
 * `indeterminate` for an animated bar when the total is unknown. Track/fill use
 * design tokens (`--muted` / `--primary`) — never hardcode colors.
 *
 * The canonical UI for streamed bulk operations (see `useBulkStream`).
 */
export function Progress({
  value = 0,
  max = 100,
  indeterminate = false,
  paused = false,
  className,
  ...props
}: ProgressProps) {
  const pct =
    max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={indeterminate ? undefined : max}
      aria-valuenow={indeterminate ? undefined : value}
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-none bg-muted",
        className,
      )}
      {...props}
    >
      {indeterminate ? (
        <div className="progress-indeterminate h-full w-1/3 bg-primary" />
      ) : (
        <div
          className={cn(
            "h-full rounded-none transition-all duration-300",
            paused ? "bg-primary/45" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}
