import { z } from "zod";
import { mealId, projectId, purchaseId, taskId } from "./identifiers";
import {
  plainDate,
  projectKindSchema,
  projectStatusSchema,
  taskStatusSchema,
  tradeSchema,
} from "./project";

export const calendarItemKind = z.enum(["meal", "task", "purchase", "project"]);
export type CalendarItemKind = z.infer<typeof calendarItemKind>;

export const calendarInteraction = z.enum(["move", "read-only"]);

const calendarItemDates = {
  startDate: plainDate,
  endDateExclusive: plainDate,
};

export const calendarMealItem = z.object({
  kind: z.literal("meal"),
  id: mealId,
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
  id: taskId,
  title: z.string(),
  ...calendarItemDates,
  interaction: z.literal("move"),
  status: taskStatusSchema,
  trade: tradeSchema,
  projectName: z.string().nullable(),
});

export const calendarPurchaseItem = z.object({
  kind: z.literal("purchase"),
  id: purchaseId,
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
  id: projectId,
  title: z.string(),
  ...calendarItemDates,
  interaction: z.literal("read-only"),
  status: projectStatusSchema,
  projectKind: projectKindSchema.nullable(),
});

export const calendarItem = z.discriminatedUnion("kind", [
  calendarMealItem,
  calendarTaskItem,
  calendarPurchaseItem,
  calendarProjectItem,
]);
export type CalendarItem = z.infer<typeof calendarItem>;

export const calendarRangeInput = z
  .object({
    startDate: plainDate,
    endDateExclusive: plainDate,
  })
  .refine((value) => value.startDate < value.endDateExclusive, {
    message: "endDateExclusive must be after startDate",
    path: ["endDateExclusive"],
  });
export type CalendarRangeInput = z.infer<typeof calendarRangeInput>;

export const calendarDaySummary = z.object({
  actualSpend: z.number(),
  plannedSpend: z.number(),
  calories: z.number(),
  nutritionPending: z.boolean(),
  taskCount: z.number().int(),
  purchaseCount: z.number().int(),
  mealCount: z.number().int(),
  projectCount: z.number().int(),
});
export type CalendarDaySummary = z.infer<typeof calendarDaySummary>;

export const calendarRangeOut = z.object({
  items: z.array(calendarItem),
  days: z.record(plainDate, calendarDaySummary),
});
export type CalendarRangeOut = z.infer<typeof calendarRangeOut>;
