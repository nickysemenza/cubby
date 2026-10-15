import { sql } from "drizzle-orm";

import { planting } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Planting = typeof planting;

// A transplant from a nursery start never has a sow date of its own; either
// date marks when the planting began.
const startedOn = (t: Planting) =>
  sql`COALESCE(${t.transplantedOn}, ${t.sowedOn})`;

export const plantingChecks = defineEntityChecks({
  entity: "planting",
  table: planting,
  checks: {
    planting_location: {
      // A still-`planned` planting may have no assigned bed yet; once it is
      // sowed/growing a location is expected.
      expected: (t: Planting) => sql`${t.status} <> 'planned'`,
      missing: (t: Planting) => sql`${t.locationId} IS NULL`,
    },
    planting_started: {
      expected: (t: Planting) => sql`${t.status} <> 'planned'`,
      missing: (t: Planting) =>
        sql`(${t.sowedOn} IS NULL AND ${t.transplantedOn} IS NULL)`,
    },
    planting_finished: {
      expected: (t: Planting) => sql`${t.status} = 'finished'`,
      missing: (t: Planting) =>
        sql`(${t.finishedOn} IS NULL OR ${t.outcome} IS NULL)`,
    },
    // Facts the status contradicts: a plan that already finished, or dates
    // that run backwards.
    planting_lifecycle: {
      missing: (t: Planting) => sql`(
        (${t.status} = 'planned' AND (${t.finishedOn} IS NOT NULL OR ${t.outcome} IS NOT NULL))
        OR (${t.status} = 'growing' AND (${t.finishedOn} IS NOT NULL OR ${t.outcome} IS NOT NULL))
        OR ${t.transplantedOn} < ${t.sowedOn}
        OR ${t.finishedOn} < ${startedOn(t)}
      )`,
    },
  },
});
