import type { ReactNode } from "react";

import { formatCount } from "~/lib/utils";

interface WorkbenchBandProps {
  title: ReactNode;
  count?: number;
  controls?: ReactNode;
  actions?: ReactNode;
}

/**
 * The list page's workbench band: page identity (title, count) plus the
 * declared view control, with a portal target the page-level table fills with
 * its query tier. Alternate renderers (shelf, timeline) keep this band in the
 * exact same place, so identity and primary actions never jump with the view.
 */
export function WorkbenchBand({
  title,
  count,
  controls,
  actions,
}: WorkbenchBandProps) {
  return (
    <div className="flex min-h-11 items-center gap-1 border-b border-border bg-card px-2 py-1 sm:gap-2">
      <div className="flex min-w-0 shrink-0 items-baseline gap-2">
        <h1 className="truncate font-heading text-base font-bold tracking-tight max-md:sr-only sm:text-lg">
          {title}
        </h1>
        {count !== undefined && (
          <span className="shrink-0 font-mono text-2xs tracking-wider text-slate uppercase tabular-nums">
            {formatCount(count)}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1 overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden">
        {controls}
        <div
          className="flex shrink-0 items-center gap-1"
          data-workbench-utilities
        />
      </div>
      {actions && (
        <div className="flex min-w-0 [scrollbar-width:none] items-center gap-2 overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden">
          {actions}
        </div>
      )}
    </div>
  );
}
