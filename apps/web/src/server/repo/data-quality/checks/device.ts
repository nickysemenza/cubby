import { sql } from "drizzle-orm";

import { device } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Device = typeof device;

export const deviceChecks = defineEntityChecks({
  entity: "device",
  table: device,
  checks: {
    device_owner_missing: {
      missing: (t: Device) => sql`${t.ledgerPartyId} IS NULL`,
    },
    device_stale: {
      missing: (t: Device) =>
        sql`(${t.lastSeenAt} IS NULL OR ${t.lastSeenAt} < now() - interval '30 days')`,
    },
  },
});
