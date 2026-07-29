/**
 * A ranged task stays active through its end date; a single-day task uses its
 * start date. Keep this pure helper client-safe so UI and repository rules use
 * the same convention.
 */
export function effectiveTaskDueDate(row: {
  dueDate: string | null;
  dueEndDate: string | null;
}): string | null {
  return row.dueEndDate ?? row.dueDate;
}
