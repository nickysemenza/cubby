import { sql } from "drizzle-orm";

import { gardenEntry } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type GardenEntry = typeof gardenEntry;

export const gardenEntryChecks = defineEntityChecks({
  entity: "gardenEntry",
  table: gardenEntry,
  checks: {
    garden_entry_note: {
      expected: (t: GardenEntry) => sql`${t.kind} = 'note'`,
      missing: (t: GardenEntry) =>
        sql`(${t.note} IS NULL OR trim(${t.note}) = '')`,
    },
    garden_entry_harvest_amount: {
      expected: (t: GardenEntry) => sql`${t.kind} = 'harvest'`,
      missing: (t: GardenEntry) =>
        sql`(${t.harvestAmount} IS NULL OR trim(${t.harvestAmount}) = '')`,
    },
  },
});
