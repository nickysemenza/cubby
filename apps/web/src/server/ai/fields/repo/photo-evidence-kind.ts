import { photoInventoryEvidence } from "~/server/db/retained-tables";
import { defineEvidence } from "~/server/kernel/api";

/** A photo pass reports what it saw; later passes append their own observations. */
export const photoInventoryObservation = defineEvidence({
  kind: "photoInventoryObservation",
  table: photoInventoryEvidence,
  keys: (row) => [
    `location-photos:${row.locationId}`,
    `photo-inventory:${row.fingerprint}`,
  ],
  discovers: (row) => [{ kind: "fields", key: `location:${row.locationId}` }],
});
