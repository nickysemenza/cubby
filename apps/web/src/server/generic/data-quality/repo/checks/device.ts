import { device } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadDeviceQualityRecords = qualityCheck.records("device", device, {
  ledgerPartyId: device.ledgerPartyId,
});

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
