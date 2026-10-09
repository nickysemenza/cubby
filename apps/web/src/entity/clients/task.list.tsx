import { taskListSlots } from "~/app/tasks/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const taskListHooks = defineListHooks("task", {
  slots: taskListSlots,
});
