import { runListSlots } from "~/app/runs/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const runListHooks = defineListHooks("run", {
  slots: runListSlots,
});
