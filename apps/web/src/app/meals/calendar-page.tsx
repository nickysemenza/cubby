import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { Link } from "@tanstack/react-router";
import { CalendarDays, ShoppingCart, Table as TableIcon } from "lucide-react";
import { UnifiedCalendar } from "~/app/calendar/unified-calendar";
import { Row, Stack } from "~/components/layout";
import type { CalendarPeriod } from "~/components/reui/event-calendar/event-calendar-types";
import { Button } from "~/components/ui/button";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import type { MealCalendarView } from "./meal-search";
import { MealTable } from "./meal-table";

const MEAL_KINDS: CalendarItemKind[] = ["meal"];
const VIEW_OPTIONS: ViewSwitcherOption<MealCalendarView>[] = [
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "table", label: "Table", icon: TableIcon },
];

interface MealCalendarPageProps {
  view: MealCalendarView;
  period: CalendarPeriod;
  week?: string;
  onViewChange: (view: MealCalendarView) => void;
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
  onViewChange,
  onPeriodChange,
  onWeekChange,
}: MealCalendarPageProps) {
  return (
    <Stack>
      <Row align="center" gap="xs">
        <ViewSwitcher
          options={VIEW_OPTIONS}
          value={view}
          onValueChange={onViewChange}
        />
        <Link to="/meals/shopping-list" className="ml-auto">
          <Button type="button" variant="outline" size="sm">
            <ShoppingCart className="size-4" />
            Shopping list
          </Button>
        </Link>
      </Row>

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
    </Stack>
  );
}
