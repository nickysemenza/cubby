import { sql } from "drizzle-orm";

import { plant } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Plant = typeof plant;

export const plantChecks = defineEntityChecks({
  entity: "plant",
  table: plant,
  checks: {
    plant_crop: {
      // A crop the garden guide does not cover can never name a guide key;
      // that is a reasoned exception that reopens if a key is later set.
      missing: (t: Plant) => sql`${t.gardenGuideKey} IS NULL`,
      fingerprint: (t: Plant) => [sql`${t.gardenGuideKey}`],
    },
  },
});
