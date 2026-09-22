import { sql } from "drizzle-orm";

import { wish } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Wish = typeof wish;

const hasLiveCandidate = (t: Wish) => sql`EXISTS (
  SELECT 1 FROM "WishCandidate" dq_wsh_c
  WHERE dq_wsh_c."wishId" = ${t.id} AND dq_wsh_c."deletedAt" IS NULL
)`;

export const wishChecks = defineEntityChecks({
  entity: "wish",
  table: wish,
  checks: {
    wish_candidate: {
      // Once a wish is acquired, its candidate product is no longer expected
      // to still be tracked as a live shopping option.
      expected: (t) => sql`${t.acquiredAt} IS NULL`,
      missing: (t) => sql`NOT ${hasLiveCandidate(t)}`,
    },
  },
});
