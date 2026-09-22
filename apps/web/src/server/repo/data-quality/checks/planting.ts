import { sql } from "drizzle-orm";

import { planting } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Planting = typeof planting;

export const plantingChecks = defineEntityChecks({
  entity: "planting",
  table: planting,
  checks: {
    planting_variety: {
      missing: (t: Planting) =>
        sql`(${t.variety} IS NULL OR trim(${t.variety}) = '')`,
    },
    planting_location: {
      // A still-`planned` planting may have no assigned bed yet; once it is
      // sowed/growing a location is expected.
      expected: (t: Planting) => sql`${t.status} <> 'planned'`,
      missing: (t: Planting) => sql`${t.locationId} IS NULL`,
    },
  },
});
