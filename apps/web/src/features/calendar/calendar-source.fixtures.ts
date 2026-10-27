import {
  calendarMealSource,
  calendarTaskSource,
  calendarExpenseSource,
  calendarProjectSource,
  calendarPlantingSource,
} from "@cubby/schemas/calendar";
import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import type {
  ExpenseShortcode,
  MealShortcode,
  ProjectShortcode,
  TaskShortcode,
} from "@cubby/schemas/identifiers";
import type { MealKind, MealType } from "@cubby/schemas/meal-classification";
import type { ProjectKind, Trade } from "@cubby/schemas/project";
import type { z } from "zod";

import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";

export function mealCalendarSourceFixture(input: {
  id: MealShortcode;
  name?: string | null;
  date?: string;
  mealType?: MealType | null;
  mealKind?: MealKind;
  recipeNames?: string[];
}) {
  const fields = calendarMealSource.shape.fields.shape;
  return entityReadFixture(calendarMealSource, {
    id: input.id,
    name: input.name ?? null,
    date: input.date ?? "2026-08-15",
    fields: {
      displayImages: fieldValueFixture(fields.displayImages, []),
      mealType: fieldValueFixture(fields.mealType, input.mealType ?? null),
      mealKind: fieldValueFixture(fields.mealKind, input.mealKind ?? "cooked"),
      recipeNames: fieldValueFixture(
        fields.recipeNames,
        input.recipeNames ?? [],
      ),
    },
  });
}
export const taskCalendarSourceFixture = (
  id: TaskShortcode,
  trade: Trade = "other",
) =>
  entityReadFixture(calendarTaskSource, {
    id,
    fields: {
      displayImages: fieldValueFixture(
        calendarTaskSource.shape.fields.shape.displayImages,
        [],
      ),
      trade: fieldValueFixture(
        calendarTaskSource.shape.fields.shape.trade,
        trade,
      ),
    },
  });
export const expenseCalendarSourceFixture = (
  id: ExpenseShortcode,
  trade: Trade | null = "other",
  vendor: string | null = null,
  displayImages: DisplayImageSummary[] = [],
) =>
  entityReadFixture(calendarExpenseSource, {
    id,
    fields: {
      displayImages: fieldValueFixture(
        calendarExpenseSource.shape.fields.shape.displayImages,
        displayImages,
      ),
      trade: fieldValueFixture(
        calendarExpenseSource.shape.fields.shape.trade,
        trade,
      ),
      vendor: fieldValueFixture(
        calendarExpenseSource.shape.fields.shape.vendor,
        vendor,
      ),
    },
  });
export const projectCalendarSourceFixture = (
  id: ProjectShortcode,
  kind: ProjectKind | null = null,
) =>
  entityReadFixture(calendarProjectSource, {
    id,
    fields: {
      displayImages: fieldValueFixture(
        calendarProjectSource.shape.fields.shape.displayImages,
        [],
      ),
      kind: fieldValueFixture(
        calendarProjectSource.shape.fields.shape.kind,
        kind,
      ),
    },
  });

export const plantingCalendarSourceFixture = (
  id: z.input<typeof calendarPlantingSource>["id"],
) =>
  entityReadFixture(calendarPlantingSource, {
    id,
    fields: {
      displayImages: fieldValueFixture(
        calendarPlantingSource.shape.fields.shape.displayImages,
        [],
      ),
    },
  });
