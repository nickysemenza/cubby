import type { CalendarDaySummary } from "@cubby/schemas/calendar";
import { format } from "date-fns";
import type { ReactNode } from "react";

import { cn, formatCurrency } from "~/lib/utils";

import { householdCalendarDate } from "./calendar-period";

const EMPTY_DAY_SUMMARY: CalendarDaySummary = {
  actualSpend: 0,
  plannedSpend: 0,
  calories: 0,
  nutritionPending: false,
  taskCount: 0,
  expenseCount: 0,
  mealCount: 0,
  projectCount: 0,
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
      className="grid grid-cols-7 bg-background"
    >
      {days.map((day, index) => {
        const summary = summaries[day] ?? EMPTY_DAY_SUMMARY;
        const date = householdCalendarDate(day);
        const isToday = day === today;
        return (
          <button
            key={day}
            type="button"
            data-day={day}
            data-today={isToday || undefined}
            aria-label={`Open ${format(date, "EEEE, MMMM d")}`}
            className={cn(
              "min-w-0 p-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
              index < days.length - 1 && "border-e",
              isToday && "bg-primary/5",
            )}
            onClick={() => onDayClick(day)}
          >
            <div className="mb-2 flex items-baseline gap-1 border-b pb-1">
              <span
                className={cn(
                  "font-mono text-2xs tracking-wider uppercase",
                  isToday ? "text-primary" : "text-slate",
                )}
              >
                {isToday ? "Today" : format(date, "EEE")}
              </span>
              <span className="ml-auto font-mono text-xs tabular-nums">
                {format(date, "d")}
              </span>
            </div>
            <dl className="space-y-1 font-mono text-2xs tabular-nums">
              <SummaryLine label="Tasks" value={summary.taskCount} />
              <SummaryLine
                label="Calories"
                value={`${Math.round(summary.calories).toLocaleString()}${summary.nutritionPending ? "+" : ""}`}
              />
              <SummaryLine
                label="Spent"
                value={formatCurrency(summary.actualSpend, 0)}
              />
              <SummaryLine
                label="Planned"
                value={formatCurrency(summary.plannedSpend, 0)}
              />
            </dl>
          </button>
        );
      })}
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <dt className="truncate text-slate">{label}</dt>
      <dd className="ml-auto shrink-0 text-foreground">{value}</dd>
    </div>
  );
}

export { EMPTY_DAY_SUMMARY, WeekSummaryGrid };
