import type { ReactNode } from "react";

import { formatCount } from "~/lib/utils";

interface WorkbenchBandProps {
  title: ReactNode;
  count?: number;
  /**
   * "N products", not "N of M": no unfiltered total is ever read (that would
   * be an extra query — see the plan's M7 correction), so the count always
   * reads as the current (possibly filtered) cohort. The caller (`page-hero.tsx`)
   * uses the declared entity plural independently of the title's rendered
   * content; this component just renders that count label.
   */
  countLabel?: string;
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
  countLabel,
  controls,
  actions,
}: WorkbenchBandProps) {
  return (
    <div
      data-workbench-band
      className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-2 max-md:sticky max-md:top-[var(--app-chrome-top)] max-md:z-20 md:px-4"
    >
      <div className="flex min-w-0 items-baseline gap-2 max-md:basis-full md:shrink-0">
        <h1 className="truncate font-heading text-xl leading-8 font-semibold tracking-tight">
          {title}
        </h1>
        {count !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {countLabel ?? formatCount(count)}
          </span>
        )}
      </div>
      <div
        className="flex min-w-0 flex-1 items-center gap-2 max-md:basis-full md:min-w-64 md:basis-64"
        data-workbench-utilities
      />
      {controls && <div className="shrink-0">{controls}</div>}
      <div className="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain">
        <div data-workbench-actions className="contents" />
        {actions}
      </div>
    </div>
  );
}
