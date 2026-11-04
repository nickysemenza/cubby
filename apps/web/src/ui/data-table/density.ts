// Single fixed row density for every data table, by surface: 24px on a desktop
// fine pointer, 32px on phones, coarse pointers and hosted native workspaces.
// `--table-row-height` in styles.css owns the value. rowHeight MUST equal the
// painted row: the virtualizer's spacer math and the fast-scroll ghost-row
// guides both key off it, and a mismatch makes them drift from the rows.
//
// A table cell grows to fit its content, so the class height is only a minimum.
// `cellContentClass` holds every cell's content to the row height (centred,
// overflow clipped) so one stacked cell cannot stretch its row. Cells must
// render a single line rather than rely on the clip.
const SSR_ROW_HEIGHT = 24;
let measuredRowHeight: number | undefined;

function rowHeight() {
  if (measuredRowHeight !== undefined) return measuredRowHeight;
  if (typeof document === "undefined") return SSR_ROW_HEIGHT;
  const parsed = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--table-row-height",
    ),
  );
  measuredRowHeight = parsed > 0 ? parsed : SSR_ROW_HEIGHT;
  // A window can cross the density breakpoint; the next read measures again.
  window
    .matchMedia?.("(min-width: 48rem) and (hover: hover) and (pointer: fine)")
    ?.addEventListener(
      "change",
      () => {
        measuredRowHeight = undefined;
      },
      { once: true },
    );
  return measuredRowHeight;
}

export const ROW_DENSITY = {
  get rowHeight() {
    return rowHeight();
  },
  cellClass:
    "h-(--table-row-height) px-1 py-0 text-sm leading-(--table-cell-leading)",
  rowClass: "h-(--table-row-height)",
  cellContentClass:
    "flex h-(--table-row-height) flex-col justify-center overflow-hidden",
} as const;
