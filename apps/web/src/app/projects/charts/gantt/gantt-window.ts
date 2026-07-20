/**
 * Visible-window math for the Gantt: the chart has no horizontal scroll
 * container, so pan and zoom are a domain transform over `[startDay, endDay]`
 * rather than a scroll offset. Every window change — wheel zoom, drag pan,
 * Reset — funnels through `clampWindow`, which is the single place the
 * viewport's legal bounds are defined.
 *
 * Pure and alias-free so it can live under the vitest `unit` project (the
 * renderer itself is `.tsx` and can't).
 */

import type { DayRange } from "./gantt-model";

/** Floor on zoom-in: closer than a fortnight and the bars lose all context. */
export const MIN_SPAN_DAYS = 14;
/** Ceiling on zoom-out, as padding either side of the data extent. */
export const MAX_SPAN_PAD_DAYS = 90;
/**
 * How far past either end of the data a pan may travel. Deliberately half
 * `MAX_SPAN_PAD_DAYS`: at maximum zoom-out the window is exactly the padded
 * extent, so the pannable range collapses to a single position and the clamp
 * agrees with `clampWindow`'s centering branch.
 */
export const PAN_PAD_DAYS = MAX_SPAN_PAD_DAYS / 2;
/** Zoom-out ceiling when there's no data to size against (~10 years). */
export const FALLBACK_MAX_SPAN_DAYS = 3650;

/** Inclusive day count of a range, so a single-day range spans 1. */
export function spanOf(range: DayRange): number {
  return range.endDay - range.startDay + 1;
}

/**
 * Snaps a candidate window onto integer days, clamps its span into
 * `[MIN_SPAN_DAYS, extentSpan + MAX_SPAN_PAD_DAYS]`, and clamps its *position*
 * so the window can never leave the data behind: panning stops once you reach
 * `PAN_PAD_DAYS` past either end of the extent.
 *
 * The position clamp is the whole point. Without it you can drag the bars
 * clean off the edge and be left staring at empty months — which is exactly
 * what a free-running start did before.
 */
export function clampWindow(next: DayRange, extent: DayRange | null): DayRange {
  const maxSpan = Math.max(
    MIN_SPAN_DAYS,
    extent == null
      ? FALLBACK_MAX_SPAN_DAYS
      : spanOf(extent) + MAX_SPAN_PAD_DAYS,
  );
  const span = Math.min(
    Math.max(Math.round(spanOf(next)), MIN_SPAN_DAYS),
    maxSpan,
  );

  let startDay = Math.round(next.startDay);
  if (extent != null) {
    const minStart = extent.startDay - PAN_PAD_DAYS;
    const maxStart = extent.endDay + PAN_PAD_DAYS - span + 1;
    startDay =
      maxStart < minStart
        ? // Window wider than the padded extent (zoomed further out than the
          // data reaches) — centre the data rather than let the clamp invert.
          Math.round((extent.startDay + extent.endDay - span) / 2)
        : Math.min(Math.max(startDay, minStart), maxStart);
  }
  return { startDay, endDay: startDay + span - 1 };
}
