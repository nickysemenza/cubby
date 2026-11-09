import { addDays, endOfWeek, format, startOfWeek } from "date-fns";
import { match } from "ts-pattern";

/**
 * Resolves a due-date preset (as read off the "due" column filter) into
 * inclusive "YYYY-MM-DD" bounds on `dueFrom`/`dueTo`, anchored on today's local
 * date (task `dueDate` is timezone-free, so bounds are computed from local
 * `today`, never UTC). An unknown/undefined preset resolves to `{}`.
 */
export function resolveDueRange(preset: string | undefined): {
  dueFrom?: string;
  dueTo?: string;
} {
  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  return match(preset)
    .with("overdue", () => ({ dueTo: todayStr }))
    .with("week", () => ({
      dueFrom: format(startOfWeek(today), "yyyy-MM-dd"),
      dueTo: format(endOfWeek(today), "yyyy-MM-dd"),
    }))
    .with("30d", () => ({
      dueFrom: todayStr,
      dueTo: format(addDays(today, 30), "yyyy-MM-dd"),
    }))
    .otherwise(() => ({}));
}
