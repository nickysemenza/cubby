import { sql } from "drizzle-orm";

import { inventoryEntry } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type InventoryEntry = typeof inventoryEntry;

export const inventoryChecks = defineEntityChecks({
  entity: "inventory",
  table: inventoryEntry,
  checks: {
    inventory_verified: {
      // Installed fixtures are excluded from counting/audits entirely (see
      // the `InventoryPlacement` doc comment in schema.ts) — only movable
      // stock is ever expected to carry a verification date.
      expected: (t: InventoryEntry) => sql`${t.placement} = 'stock'`,
      missing: (t: InventoryEntry) => sql`${t.verifiedAt} IS NULL`,
    },
  },
});
