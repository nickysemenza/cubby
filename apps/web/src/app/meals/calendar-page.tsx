import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { Link } from "@tanstack/react-router";
import { CalendarDays, ShoppingCart, Table as TableIcon } from "lucide-react";
import { UnifiedCalendar } from "~/app/calendar/unified-calendar";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import type { MealCalendarView } from "./meal-search";
import { MealTable } from "./meal-table";

const MEAL_KINDS: CalendarItemKind[] = ["meal"];

interface MealCalendarPageProps {
  view: MealCalendarView;
  week?: string;
  onViewChange: (view: MealCalendarView) => void;
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
  week,
  onViewChange,
  onWeekChange,
}: MealCalendarPageProps) {
  return (
    <Stack>
      <Row align="center" gap="xs">
        <div className="inline-flex overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => onViewChange("calendar")}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-sm ${view === "calendar" ? "bg-accent font-medium" : "text-muted-foreground"}`} /* tight: segmented toggle icon+label */
          >
            <CalendarDays className="size-4" />
            Calendar
          </button>
          <button
            type="button"
            onClick={() => onViewChange("table")}
            className={`flex items-center gap-1.5 border-l px-2.5 py-1 text-sm ${view === "table" ? "bg-accent font-medium" : "text-muted-foreground"}`} /* tight: segmented toggle icon+label */
          >
            <TableIcon className="size-4" />
            Table
          </button>
        </div>
        <Link to="/meals/shopping-list" className="ml-auto">
          <Button type="button" variant="outline" size="sm">
            <ShoppingCart className="size-4" />
            Shopping list
          </Button>
        </Link>
      </Row>

      {view === "calendar" ? (
        <UnifiedCalendar
          date={week}
          lockedKinds={MEAL_KINDS}
          onDateChange={onWeekChange}
        />
      ) : (
        <MealTable />
      )}
    </Stack>
  );
}
