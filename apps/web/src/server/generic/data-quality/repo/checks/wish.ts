import { sql } from "drizzle-orm";

import { wish } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Wish = typeof wish;

// The link alone is not a candidate: it must still reach a live Product.
const hasLiveCandidate = (t: Wish) => sql`EXISTS (
  SELECT 1 FROM "EntityLink" dq_wsh_c
  JOIN "Product" dq_wsh_p ON dq_wsh_p."id" = dq_wsh_c."toEntityId" AND dq_wsh_p."deletedAt" IS NULL
  WHERE dq_wsh_c."fromEntityId" = ${t.id} AND dq_wsh_c."deletedAt" IS NULL AND dq_wsh_c."kind" = 'wishCandidate'
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
