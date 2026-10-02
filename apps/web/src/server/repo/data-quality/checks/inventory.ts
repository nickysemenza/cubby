import { sql } from "drizzle-orm";

import { inventoryEntry } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type InventoryEntry = typeof inventoryEntry;

export const inventoryChecks = defineEntityChecks({
  entity: "inventory",
  table: inventoryEntry,
  checks: {
    inventory_unknown_location: {
      missing: (t) => sql`EXISTS (
        SELECT 1 FROM "Location" dq_unknown_location
        WHERE dq_unknown_location."id" = ${t.locationId}
          AND dq_unknown_location."deletedAt" IS NULL AND dq_unknown_location."name" = 'Unknown'
      )`,
    },
    inventory_verified: {
      // Installed fixtures are excluded from counting/audits entirely (see
      // the `InventoryPlacement` doc comment in schema.ts) — only movable
      // stock is ever expected to carry a verification date.
      expected: (t: InventoryEntry) => sql`${t.placement} = 'stock'`,
      missing: (t: InventoryEntry) => sql`${t.verifiedAt} IS NULL`,
    },
  },
});
