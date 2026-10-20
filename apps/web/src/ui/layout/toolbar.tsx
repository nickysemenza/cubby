import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

type ToolbarProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  /** Accessible name ("Purchase filters", "Photo review actions"). */
  label: string;
  /** Leading controls: Filter, Sort, View, a mode switch. */
  start?: ReactNode;
  /** Trailing controls: search, the region's primary action. */
  end?: ReactNode;
  /** A full-width row beneath the controls (active filter chips). */
  below?: ReactNode;
};

/**
 * Controls that act on the content beneath them: a leading and a trailing
 * group on one row that wraps before it overflows, with an optional row
 * below. Tab order follows reading order; the toolbar adds no roving focus
 * because it routinely hosts a text input.
 */
export function Toolbar({
  label,
  start,
  end,
  below,
  className,
  ...props
}: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      data-slot="toolbar"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {start != null && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {start}
          </div>
        )}
        {end != null && (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {end}
          </div>
        )}
      </div>
      {below}
    </div>
  );
}
