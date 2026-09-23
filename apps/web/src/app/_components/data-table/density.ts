// Single fixed row density ("compact") for every data table. Persistence and
// the per-table density toggle were removed; rowHeight MUST equal the
// cellClass/rowClass h-* pixel value — the virtualizer's spacer math and the
// fast-scroll ghost-row guides both key off rowHeight, and a mismatch makes
// them drift from the painted rows.
export const ROW_DENSITY = {
  rowHeight: 32,
  cellClass: "h-8 px-2 py-0 text-[0.8125rem] leading-5",
  rowClass: "h-8",
} as const;
