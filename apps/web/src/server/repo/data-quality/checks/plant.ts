import { sql } from "drizzle-orm";

import { plant } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Plant = typeof plant;

export const plantChecks = defineEntityChecks({
  entity: "plant",
  table: plant,
  checks: {
    plant_crop: {
      missing: (t: Plant) => sql`${t.gardenGuideKey} IS NULL`,
    },
  },
});
