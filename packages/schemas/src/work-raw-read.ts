import { readSchemas as projectDefinitionSchemas } from "./entity-definitions/09-project.entity";
import { readSchemas as taskDefinitionSchemas } from "./entity-definitions/10-task.entity";
import { readSchemas as expenseDefinitionSchemas } from "./entity-definitions/16-expense.entity";
import { withEntityListMedia } from "./entity-media-raw-read";
import type { z } from "zod";

/** Repository/compiler reads; public work entities use generated field envelopes. */
export const rawProjectOut = projectDefinitionSchemas.output;
export const rawProjectListItemOut = withEntityListMedia(
  projectDefinitionSchemas.list,
);
export type RawProjectOut = z.output<typeof rawProjectOut>;
export type RawProjectListItemOut = z.output<typeof rawProjectListItemOut>;

export const rawTaskOut = taskDefinitionSchemas.output;
export const rawTaskListItemOut = withEntityListMedia(
  taskDefinitionSchemas.list,
);
export type RawTaskOut = z.output<typeof rawTaskOut>;
export type RawTaskListItemOut = z.output<typeof rawTaskListItemOut>;

export const rawExpenseOut = expenseDefinitionSchemas.output;
export const rawExpenseListItemOut = withEntityListMedia(
  expenseDefinitionSchemas.list,
);
export type RawExpenseOut = z.output<typeof rawExpenseOut>;
export type RawExpenseListItemOut = z.output<typeof rawExpenseListItemOut>;

/** Private orchestration retains raw rows until the public operation serializes them. */
export type RawActionableTaskOut = RawTaskOut;
export type RawBlockedTaskOut = Omit<
  import("./project").BlockedTaskOut,
  "task"
> & {
  task: RawTaskOut;
};
export type RawActionableTasksOut = Omit<
  import("./project").ActionableTasksOut,
  "next" | "later" | "blocked"
> & {
  next: RawTaskOut[];
  later: RawTaskOut[];
  blocked: RawBlockedTaskOut[];
};
export type RawProjectDashboardSummaryOut = Omit<
  import("./project").ProjectDashboardSummaryOut,
  "projects" | "nextTasks"
> & {
  projects: RawProjectOut[];
  nextTasks: RawTaskOut[];
};

export type RawTaskTimelineOut = Omit<
  import("./project").TaskTimelineOut,
  "tasks"
> & {
  tasks: RawTaskOut[];
};
export type RawCalendarScheduleOut = Omit<
  import("./calendar").CalendarScheduleOut,
  "tasks" | "plantings"
> & {
  tasks: RawTaskOut[];
  plantings: import("./planting-raw-read").RawPlantingOut[];
};
