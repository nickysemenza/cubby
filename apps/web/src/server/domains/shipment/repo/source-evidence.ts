import { shipmentSourceCapture } from "~/server/db/schema";
import { defineEvidence, rowKey } from "~/server/kernel/api";

/** Original captures are immutable; package identities are supplied by their observations. */
export const shipmentCaptureEvidence = defineEvidence({
  kind: "shipment.capture",
  table: shipmentSourceCapture,
  keys: (row) => [
    rowKey("ShipmentSourceCapture", row.id),
    `shipment:source:${row.sourceKey}`,
    ...(row.emailId ? [rowKey("Email", row.emailId)] : []),
  ],
  discovers: (row) =>
    row.emailId ? [{ kind: "emailState", key: row.emailId }] : [],
  owner: (row) => row.actorUserId,
});
