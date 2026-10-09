import { projectListSlots } from "~/app/projects/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const projectListHooks = defineListHooks("project", {
  slots: projectListSlots,
});
