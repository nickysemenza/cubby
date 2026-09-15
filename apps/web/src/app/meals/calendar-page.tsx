import type { CalendarItemKind } from "@cubby/schemas/calendar";
import {
  ChartNoAxesColumn,
  CalendarDays,
  Table as TableIcon,
} from "lucide-react";

import { UnifiedCalendar } from "~/app/calendar/unified-calendar";
import type { CalendarPeriod } from "~/components/reui/event-calendar/event-calendar-types";
import type { ViewSwitcherOption } from "~/components/ui/view-switcher";

import type { MealCalendarView } from "./meal-search";
import { MealTable } from "./meal-table";

const MEAL_KINDS: CalendarItemKind[] = ["meal"];
export const MEAL_VIEW_OPTIONS: ViewSwitcherOption<MealCalendarView>[] = [
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "nutrition", label: "Nutrition", icon: ChartNoAxesColumn },
  { value: "table", label: "Table", icon: TableIcon },
];

interface MealCalendarPageProps {
  view: MealCalendarView;
  period: CalendarPeriod;
  week?: string;
  onPeriodChange: (period: CalendarPeriod) => void;
  onWeekChange: (week?: string) => void;
}

/**
 * Meals retain their table workflow, while the calendar tab shares the same
 * month engine, meal chips, drag behavior, and day drawer as `/calendar`.
 * The legacy `week` search key remains accepted as the month anchor so old
 * meal-calendar links keep working.
 */
export function MealCalendarPage({
  view,
  period,
  week,
  onPeriodChange,
  onWeekChange,
}: MealCalendarPageProps) {
  return (
    <>
      {view === "calendar" ? (
        <UnifiedCalendar
          period={period}
          date={week}
          lockedKinds={MEAL_KINDS}
          onPeriodChange={onPeriodChange}
          onDateChange={onWeekChange}
        />
      ) : (
        <MealTable />
      )}
    </>
  );
}
