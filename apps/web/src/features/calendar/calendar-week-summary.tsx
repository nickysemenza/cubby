import type { CalendarDaySummary } from "@cubby/schemas/calendar";
import { cn } from "cn";
import { format } from "date-fns";

import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { aggregateTotals } from "~/lib/nutrition-estimates";
import { formatEstimate } from "~/lib/nutrition-format";

import { householdCalendarDate } from "./calendar-period";

const EMPTY_DAY_SUMMARY: CalendarDaySummary = {
  actualSpend: 0,
  plannedSpend: 0,
  mealTotals: aggregateTotals([]),
  taskCount: 0,
  expenseCount: 0,
  mealCount: 0,
  projectCount: 0,
  itemIds: [],
};

function WeekSummaryGrid({
  days,
  summaries,
  today,
  onDayClick,
}: {
  days: string[];
  summaries: Record<string, CalendarDaySummary>;
  today: string;
  onDayClick: (day: string) => void;
}) {
  return (
    <div
      data-slot="calendar-week-summary"
      className="grid grid-cols-7 border-b bg-background"
    >
      {days.map((day, index) => {
        const summary = summaries[day] ?? EMPTY_DAY_SUMMARY;
        const date = householdCalendarDate(day);
        const isToday = day === today;
        const kcal = summary.mealTotals.nutrition.kcal;
        // Counts that are zero or unknown say nothing; the date row keeps money.
        const counts = [
          summary.taskCount
            ? `${summary.taskCount} ${summary.taskCount === 1 ? "task" : "tasks"}`
            : null,
          kcal.status === "unavailable"
            ? null
            : formatEstimate(kcal, "kcal", "kcal"),
        ].filter(Boolean);
        return (
          <button
            key={day}
            type="button"
            data-day={day}
            data-today={isToday || undefined}
            aria-label={`Open ${formatCalendarDay(date, "weekdayLongMonthDay")}`}
            className={cn(
              "min-w-0 px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
              index < days.length - 1 && "border-e",
              isToday && "bg-primary/3",
            )}
            onClick={() => onDayClick(day)}
          >
            <div className="flex min-w-0 items-baseline gap-1">
              <span
                className={cn(
                  "shrink-0 text-xs font-medium",
                  isToday ? "text-primary" : "text-foreground",
                )}
              >
                {format(date, "EEE d")}
              </span>
              <span className="ml-auto flex min-w-0 items-baseline gap-1 truncate font-mono text-2xs text-muted-foreground tabular-nums">
                {summary.actualSpend !== 0 && (
                  <span>
                    <span className="sr-only">Recorded spend </span>
                    {formatCurrency(summary.actualSpend)}
                  </span>
                )}
                {summary.plannedSpend !== 0 && (
                  <span className="text-warning-ink">
                    <span className="sr-only">Planned spend </span>
                    {formatCurrency(summary.plannedSpend)}
                  </span>
                )}
              </span>
            </div>
            <div className="h-4 truncate text-2xs leading-4 text-muted-foreground">
              {counts.join(" · ")}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export { EMPTY_DAY_SUMMARY, WeekSummaryGrid };
