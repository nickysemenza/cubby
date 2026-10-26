/** Fit the whole period, keeping cells near square and dates readable. */
export function calendarOverviewLayout({
  width,
  height,
  dayCount,
  startWeekday,
  aligned,
}: {
  width: number;
  height: number;
  dayCount: number;
  startWeekday: number;
  aligned: boolean;
}) {
  const offset = aligned ? startWeekday : 0;
  const idealColumns = Math.sqrt(
    (width * (dayCount + offset)) / Math.max(1, height),
  );
  const step = aligned ? 7 : 1;
  const maximum = Math.max(step, Math.floor(width / 36 / step) * step);
  // Round up: the shorter rows from rounding down can lose their only event
  // lane even when the next column count still has readable date widths.
  const columns = Math.min(
    maximum,
    Math.max(step, Math.ceil(idealColumns / step) * step),
  );
  const rows = Math.ceil((dayCount + offset) / columns);
  // Reserve the date heading and overflow line even on crowded days.
  const lanes = Math.max(0, Math.floor((height / rows - 36) / 18));
  return { columns, rows, offset, lanes };
}
