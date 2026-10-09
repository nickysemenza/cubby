import { plantingListSlots } from "~/app/plantings/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const plantingListHooks = defineListHooks("planting", {
  slots: plantingListSlots,
});
