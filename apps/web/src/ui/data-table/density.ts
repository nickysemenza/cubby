import { createContext, useSyncExternalStore } from "react";

// One fixed row height per table. A fine-pointer desktop draws 28px rows
// (54px in two-line mode) under a 30px header; phones, coarse pointers and
// hosted native workspaces draw 32px (54px). styles.css owns the same numbers
// as `--table-row-height` and `--table-row-height-two-line`. `row` MUST equal
// the painted row: the virtualizer's spacer math and the fast-scroll ghost-row
// guides key off it, and a mismatch makes them drift from the rows.
//
// A table cell grows to fit its content, so the class height is only a
// minimum. `cellContentClass` holds every cell's content to the row height
// (centred, overflow clipped) so one stacked cell cannot stretch its row.

/** Single rows, or the title over a declared secondary line. */
export type RowLines = "single" | "double";

const DESKTOP_QUERY =
  "(min-width: 48rem) and (hover: hover) and (pointer: fine)";

function desktopDensity() {
  // The server renders the desktop scale; hydration re-reads the media.
  if (typeof window === "undefined") return true;
  return (
    (window.matchMedia?.(DESKTOP_QUERY).matches ?? true) &&
    !document.documentElement.hasAttribute("data-hosted-workspace")
  );
}

const SINGLE = {
  rowClass: "h-(--table-row-height)",
  cellClass:
    "h-(--table-row-height) px-1 py-0 text-sm leading-(--table-cell-leading)",
  cellContentClass:
    "flex h-(--table-row-height) flex-col justify-center overflow-hidden",
} as const;

const DOUBLE = {
  rowClass: "h-(--table-row-height-two-line)",
  cellClass:
    "h-(--table-row-height-two-line) px-1 py-0 text-sm leading-(--table-cell-leading)",
  cellContentClass:
    "flex h-(--table-row-height-two-line) flex-col justify-center overflow-hidden",
} as const;

/** The row and cell classes for one row-lines mode; reads no media. */
export const rowLineClasses = (lines: RowLines) =>
  lines === "double" ? DOUBLE : SINGLE;

/**
 * A table's row geometry. Embedded tables are always single; `row` is the
 * virtualizer's estimate and `header` the column-head height in px.
 */
export function rowDensity({
  lines = "single",
  embedded = false,
}: { lines?: RowLines; embedded?: boolean } = {}) {
  const double = lines === "double" && !embedded;
  const desktop = desktopDensity();
  return {
    lines: double ? ("double" as const) : ("single" as const),
    row: double ? 54 : desktop ? 28 : 32,
    header: desktop ? 30 : 32,
    ...(double ? DOUBLE : SINGLE),
  };
}

export type RowDensity = ReturnType<typeof rowDensity>;

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(DESKTOP_QUERY);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/** `rowDensity` that re-reads when a window crosses the density breakpoint. */
export function useRowDensity(options: {
  lines?: RowLines;
  embedded?: boolean;
}): RowDensity {
  // Subscribed only to re-render on a breakpoint crossing.
  useSyncExternalStore(subscribe, desktopDensity, () => true);
  return rowDensity(options);
}

/**
 * The table's row lines, for cells that draw a declared secondary line
 * (the identity's second line, a progress meter's block form).
 */
export const RowLinesContext = createContext<RowLines>("single");
