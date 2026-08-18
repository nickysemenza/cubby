import { addDays, format, isValid, parseISO, startOfWeek } from "date-fns";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { calendarPeriodParam } from "~/app/calendar/calendar-search";
import {
  entityFilterSearchFields,
  routeFilterValues,
} from "~/entities/filter-search-fields";
import { urlEnumListParam, urlStringParam } from "~/lib/search-params";

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
  period: calendarPeriodParam,
  week: dateParamSchema,
  // Meals have no /meals/new route — the create is a dialog, opened by this
  // param. That makes it deep-linkable, which is what lets the action registry
  // and the empty-state CTA point at it (they can only express a destination).
  create: z.boolean().optional().catch(undefined),
  ...tableSearchFields,
  ...entityFilterSearchFields("meal"),
  mealType: urlEnumListParam(z.enum(routeFilterValues.mealType)),
  mealKind: urlEnumListParam(z.enum(routeFilterValues.mealKind)),
});

export const mealCalendarSearchDefaults = {
  view: undefined,
  period: undefined,
  week: undefined,
  create: undefined,
} as const;

/** A renderer, not a view: both draw the same server-selected set. */
export type ShoppingListView = "list" | "matrix";

export const shoppingListSearchSchema = z.object({
  // A bare enum is right here — neither token is a JSON literal, so TanStack's
  // parseSearch won't coerce it (that's what `urlStringParam` exists for).
  view: z.enum(["list", "matrix"]).optional().catch(undefined),
  from: dateParamSchema,
  to: dateParamSchema,
  // Comma-joined meal shortcodes rather than a JSON array, so a shared list
  // stays readable (`?excluded=MEL-4K7M,MEL-ZX4C`). `urlStringParam` because
  // TanStack's parseSearch JSON-parses every value; shortcodes aren't JSON
  // tokens today, but the helper is the house rule and costs nothing.
  excluded: urlStringParam,
});

export const shoppingListSearchDefaults = {
  view: undefined,
  from: undefined,
  to: undefined,
  excluded: undefined,
} as const;

/** `?excluded=` text ⇄ the set the renderers use. Empty means nothing hidden. */
export const parseExcludedMeals = (value: string | undefined): string[] =>
  value ? value.split(",").filter(Boolean) : [];

export const serializeExcludedMeals = (ids: ReadonlySet<string>): string =>
  [...ids].join(",");

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
