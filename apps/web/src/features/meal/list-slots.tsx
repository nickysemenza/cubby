import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import type {
  ListSlotComponent,
  ListSlotProps,
} from "~/entity/entity-list/list-slot-types";
import { entityCalendar } from "~/features/calendar/entity-calendar";
import { householdLocalDate } from "~/lib/household-date";

import { DailyNutrition } from "./daily-nutrition";

const REPLACE = { replace: true } as const;

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
  calendar: entityCalendar("meal"),
  nutrition: MealNutritionSlot,
} satisfies Record<ListSlotId<"meal">, ListSlotComponent>;
