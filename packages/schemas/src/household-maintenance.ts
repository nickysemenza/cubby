import { z } from "zod";
import { plainDate } from "./base-entity";
import {
  productShortcode,
  projectShortcode,
  taskShortcode,
} from "./identifier-fields";

export const maintenanceHistoryGroup = z.object({
  name: z.string(),
  subjectProductId: productShortcode.nullable(),
  subjectProductName: z.string().nullable(),
  taskIds: z.array(taskShortcode),
  completedDates: z.array(plainDate),
  undatedCompletions: z.number().int().nonnegative(),
  medianIntervalDays: z.number().positive().nullable(),
});

export const maintenanceHistoryOut = z.object({
  groups: z.array(maintenanceHistoryGroup),
  projectIds: z.array(projectShortcode),
});
