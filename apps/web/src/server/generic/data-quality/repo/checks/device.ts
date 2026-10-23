import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { device } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const DEVICE_QUALITY_RULES_VERSION = 1;

type DeviceQualityRecord = Awaited<
  ReturnType<typeof loadDeviceQualityRecords>
>[number];

export const deviceChecks = defineStoredEntityChecks({
  entity: "device",
  table: device,
  rulesVersion: DEVICE_QUALITY_RULES_VERSION,
  load: loadDeviceQualityRecords,
  checks: {
    device_display_image: qualityCheck.hasImage,
    // Check-in recency is operational state, not a completeness fact.
    device_owner_missing:
      qualityCheck.required<DeviceQualityRecord>("ledgerPartyId"),
  },
});

async function loadDeviceQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: device.id,
      shortcode: device.shortcode,
      ledgerPartyId: device.ledgerPartyId,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("device", sql`${device.id}`)}`,
    })
    .from(device)
    .where(
      and(notDeleted(device), sql`${device.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
