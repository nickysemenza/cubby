import type { ReactNode } from "react";

import { formatCount } from "~/lib/utils";

interface WorkbenchBandProps {
  title: ReactNode;
  count?: number;
  /**
   * "N products", not "N of M": no unfiltered total is ever read (that would
   * be an extra query — see the plan's M7 correction), so the count always
   * reads as the current (possibly filtered) cohort. The caller (`page-hero.tsx`)
   * decides the plural — every workbench route's title IS the entity's plural
   * label (`listPage` sets `title: plural ?? singular`) — since only it knows
   * whether `title` is the plain string that reads sensibly lowercased next to
   * a count; this component just renders whatever string it's given.
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
    // Below `md` this wraps into two lines — identity+New, then the
    // seg+query tier (a third line, the active-chip strip, lives inside the
    // portal target's own mobile fragment — see `MobileFilterTier`) — via
    // `flex-wrap` + `order` + a `basis-full` break, not by mounting `actions`
    // twice: a duplicate node stays in the a11y tree at both breakpoints in
    // any environment that doesn't compute real CSS media queries (jsdom
    // tests included), so it must be one node repositioned, not two.
    // Sticky below `md` only — the desktop shell doesn't need it, and
    // `--app-chrome-top` accounts for the phone's fixed top nav.
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-border bg-card px-2 py-1.5 max-md:sticky max-md:top-[var(--app-chrome-top)] max-md:z-20 md:min-h-11 md:flex-nowrap md:py-1">
      <div className="order-1 flex min-w-0 shrink-0 items-baseline gap-2">
        <h1 className="truncate font-heading text-xl leading-6 font-bold tracking-tight sm:text-lg sm:leading-6">
          {title}
        </h1>
        {count !== undefined && (
          <span className="shrink-0 font-mono text-2xs tracking-wider text-slate uppercase tabular-nums">
            {countLabel ?? formatCount(count)}
          </span>
        )}
      </div>
      {actions && (
        <div className="order-2 flex min-w-0 [scrollbar-width:none] items-center gap-2 overflow-x-auto overscroll-x-contain md:order-3 md:shrink-0 [&::-webkit-scrollbar]:hidden">
          {actions}
        </div>
      )}
      <div className="order-3 flex min-w-0 basis-full [scrollbar-width:none] items-center gap-1 overflow-x-auto overscroll-x-contain md:order-2 md:flex-1 md:basis-auto [&::-webkit-scrollbar]:hidden">
        {controls}
        <div
          className="flex min-w-0 flex-1 items-center gap-1"
          data-workbench-utilities
        />
      </div>
    </div>
  );
}
