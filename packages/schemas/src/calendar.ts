import { z } from "zod";
import {
  mealShortcode,
  projectShortcode,
  expenseShortcode,
  taskShortcode,
} from "./identifiers";
import {
  plainDate,
  projectKindSchema,
  projectStatusSchema,
  taskStatusSchema,
  tradeSchema,
} from "./project";

export const MAX_CALENDAR_RANGE_DAYS = 366;
const MILLISECONDS_PER_DAY = 86_400_000;

function calendarRangeDays(value: {
  startDate: string;
  endDateExclusive: string;
}): number {
  return (
    (Date.parse(`${value.endDateExclusive}T00:00:00Z`) -
      Date.parse(`${value.startDate}T00:00:00Z`)) /
    MILLISECONDS_PER_DAY
  );
}

export const calendarItemKind = z.enum(["meal", "task", "expense", "project"]);
export type CalendarItemKind = z.infer<typeof calendarItemKind>;

export const calendarInteraction = z.enum(["move", "read-only"]);

const calendarItemDates = {
  startDate: plainDate,
  endDateExclusive: plainDate,
};

export const calendarMealItem = z.object({
  kind: z.literal("meal"),
  id: mealShortcode,
  title: z.string(),
  ...calendarItemDates,
  interaction: z.literal("move"),
  sortOrder: z.number().int().nullable(),
  recipeNames: z.array(z.string()),
  cost: z.number(),
  calories: z.number(),
  nutritionPending: z.boolean(),
});

export const calendarTaskItem = z.object({
  kind: z.literal("task"),
  id: taskShortcode,
  title: z.string(),
  ...calendarItemDates,
  interaction: z.literal("move"),
  status: taskStatusSchema,
  trade: tradeSchema,
  projectName: z.string().nullable(),
});

export const calendarExpenseItem = z.object({
  kind: z.literal("expense"),
  id: expenseShortcode,
  title: z.string(),
  ...calendarItemDates,
  interaction: calendarInteraction,
  future: z.boolean(),
  cost: z.number().nullable(),
  vendor: z.string().nullable(),
  trade: tradeSchema,
  projectName: z.string().nullable(),
});

export const calendarProjectItem = z.object({
  kind: z.literal("project"),
  id: projectShortcode,
  title: z.string(),
  ...calendarItemDates,
  interaction: z.literal("read-only"),
  status: projectStatusSchema,
  projectKind: projectKindSchema.nullable(),
});

export const calendarItem = z.discriminatedUnion("kind", [
  calendarMealItem,
  calendarTaskItem,
  calendarExpenseItem,
  calendarProjectItem,
]);
export type CalendarItem = z.infer<typeof calendarItem>;

export const calendarRangeInput = z
  .object({
    startDate: plainDate,
    endDateExclusive: plainDate,
    /**
     * Which item kinds to read. Omitted means all four — the in-app calendar
     * wants everything, so that stays the default. Narrowing it lets a caller
     * skip whole queries: asking for meals alone avoids the expense read and
     * the project subtree rollup entirely (see repo/calendar.ts).
     */
    kinds: z.array(calendarItemKind).nonempty().optional(),
  })
  .refine((value) => value.startDate < value.endDateExclusive, {
    message: "endDateExclusive must be after startDate",
    path: ["endDateExclusive"],
  })
  .refine((value) => calendarRangeDays(value) <= MAX_CALENDAR_RANGE_DAYS, {
    message: `calendar range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days`,
    path: ["endDateExclusive"],
  });
export type CalendarRangeInput = z.infer<typeof calendarRangeInput>;

export const calendarDaySummary = z.object({
  actualSpend: z.number(),
  plannedSpend: z.number(),
  calories: z.number(),
  nutritionPending: z.boolean(),
  taskCount: z.number().int(),
  expenseCount: z.number().int(),
  mealCount: z.number().int(),
  projectCount: z.number().int(),
});
export type CalendarDaySummary = z.infer<typeof calendarDaySummary>;

export const calendarRangeOut = z.object({
  items: z.array(calendarItem),
  days: z.record(plainDate, calendarDaySummary),
});
export type CalendarRangeOut = z.infer<typeof calendarRangeOut>;
