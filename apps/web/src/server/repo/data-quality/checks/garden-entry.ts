import { gardenEntry } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";
import { sameRecordClassificationChecks } from "./classification-policy";

const policyChecks = new Map(
  sameRecordClassificationChecks("gardenEntry", gardenEntry),
);

export const gardenEntryChecks = defineEntityChecks({
  entity: "gardenEntry",
  table: gardenEntry,
  checks: {
    garden_entry_note: policyChecks.get("garden_entry_note")!,
    garden_entry_harvest_amount: policyChecks.get(
      "garden_entry_harvest_amount",
    )!,
  },
});
