import type { CalendarItemKind } from "@cubby/schemas/calendar";
import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import type {
  ListSlotComponent,
  ListSlotProps,
} from "~/app/_components/entity-list/list-slot-types";
import { calendarPeriodParam } from "~/app/calendar/calendar-search";
import { UnifiedCalendar } from "~/app/calendar/unified-calendar";
import { householdLocalDate } from "~/lib/household-date";

import { DailyNutrition } from "./daily-nutrition";

const MEAL_KINDS: CalendarItemKind[] = ["meal"];
// Date navigation replaces history so Back leaves the page, not the month.
const REPLACE = { replace: true } as const;
const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

/**
 * The calendar view shares the month engine, meal chips, drag behavior and
 * day drawer with `/calendar`. `week` stays the month anchor so old
 * meal-calendar links keep working.
 */
function MealCalendarSlot({ search, navigate }: ListSlotProps) {
  const period = calendarPeriodParam.parse(search.period) ?? "month";
  const week = dateParam.parse(search.week);
  return (
    <UnifiedCalendar
      period={period}
      date={week}
      lockedKinds={MEAL_KINDS}
      onPeriodChange={(next) =>
        navigate({ period: next === "month" ? undefined : next }, REPLACE)
      }
      onDateChange={(next) => navigate({ week: next }, REPLACE)}
    />
  );
}

function MealNutritionSlot({ search, navigate }: ListSlotProps) {
  const date = z.iso.date().optional().catch(undefined).parse(search.date);
  return (
    <DailyNutrition
      date={date}
      initialToday={householdLocalDate()}
      onDateChange={(next) => navigate({ date: next }, REPLACE)}
    />
  );
}

export const mealListSlots = {
  calendar: MealCalendarSlot,
  nutrition: MealNutritionSlot,
} satisfies Record<ListSlotId<"meal">, ListSlotComponent>;
