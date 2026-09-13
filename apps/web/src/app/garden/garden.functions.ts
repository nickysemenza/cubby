import { gardenContract } from "~/contracts/garden.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const garden = defineOperationDomain(gardenContract, {
  overview: {
    tags: [
      ["garden"],
      ["planting"],
      ["gardenEntry"],
      ["location"],
      ["ingredient"],
      ["product"],
    ],
  },
  options: {
    tags: [["garden"], ["location"], ["ingredient"], ["product"], ["planting"]],
  },
  entries: {
    tags: [
      ["garden"],
      ["gardenEntry"],
      ["location"],
      ["planting"],
      ["ingredient"],
      ["image"],
    ],
  },
  journal: {
    tags: [
      ["garden"],
      ["gardenEntry"],
      ["planting"],
      ["location"],
      ["ingredient"],
      ["image"],
    ],
  },
  locationHistory: { tags: [["garden"], ["planting"], ["location"]] },
  correctLocationDates: { invalidates: ripple.garden },
  guides: { tags: [["garden", "guides"]] },
  createPlanting: { invalidates: ripple.garden },
  recordEntry: { invalidates: ripple.garden },
  startPlanting: { invalidates: ripple.garden },
  movePlanting: { invalidates: ripple.garden },
  splitPlanting: { invalidates: ripple.garden },
  finishPlanting: { invalidates: ripple.garden },
});
