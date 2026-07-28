import { addDays, format, isValid, parseISO, startOfWeek } from "date-fns";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";

const dateParamSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

export type MealCalendarView = "calendar" | "table";

// Merges `tableSearchFields` (sort/page/pageSize) so the Table view's
// useTableState urlSync round-trips through this route's search params —
// without it, this strict z.object strips those keys on every navigate and
// the table's sort/page silently resets (see tasks.index.tsx for the same
// pattern).
export const mealCalendarSearchSchema = z.object({
  view: z.enum(["calendar", "table"]).optional().catch(undefined),
  week: dateParamSchema,
  ...tableSearchFields,
});

export const mealCalendarSearchDefaults = {
  view: undefined,
  week: undefined,
} as const;

export const shoppingListSearchSchema = z.object({
  from: dateParamSchema,
  to: dateParamSchema,
});

export const shoppingListSearchDefaults = {
  from: undefined,
  to: undefined,
} as const;

export const mealSuggestionFilters = [
  { label: "All", value: "all", minCoverage: 0 },
  { label: "Almost there", value: "almost", minCoverage: 0.5 },
  { label: "Ready", value: "ready", minCoverage: 1 },
] as const;

export type MealSuggestionFilter =
  (typeof mealSuggestionFilters)[number]["value"];

export const mealSuggestionsSearchSchema = z.object({
  filter: z.enum(["almost", "ready"]).optional().catch(undefined),
});

export const mealSuggestionsSearchDefaults = { filter: undefined } as const;

const getCurrentWeekStart = (referenceDate = new Date()) =>
  startOfWeek(referenceDate, { weekStartsOn: 0 });

export const parseWeekStart = (week?: string, referenceDate = new Date()) => {
  if (!week) return getCurrentWeekStart(referenceDate);
  const parsed = parseISO(week);
  return isValid(parsed)
    ? startOfWeek(parsed, { weekStartsOn: 0 })
    : getCurrentWeekStart(referenceDate);
};

export const formatWeekSearch = (date: Date) => format(date, "yyyy-MM-dd");

export const getDefaultShoppingRange = (referenceDate = new Date()) => {
  const weekStart = getCurrentWeekStart(referenceDate);
  return {
    from: format(weekStart, "yyyy-MM-dd"),
    to: format(addDays(weekStart, 6), "yyyy-MM-dd"),
  };
};
