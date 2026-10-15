import { sql } from "drizzle-orm";

import { device } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Device = typeof device;

// Check-in recency is operational state, not a
// completeness fact about the record, so it is deliberately not a check.
export const deviceChecks = defineEntityChecks({
  entity: "device",
  table: device,
  checks: {
    device_owner_missing: {
      missing: (t: Device) => sql`${t.ledgerPartyId} IS NULL`,
    },
  },
});
