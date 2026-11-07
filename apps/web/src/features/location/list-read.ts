import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const locationListReadProjection = specialistListReadProjection({
  always: ["parent", "type"],
  whenRevealed: {
    children: ["children"],
    inventoryEntries: ["inventoryEntries"],
  },
});
