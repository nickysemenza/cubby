import { locationListSlots } from "~/app/locations/list-slots";
import { defineListHooks } from "~/entity/entity-list/list-hooks";

export const locationListHooks = defineListHooks("location", {
  slots: locationListSlots,
});
