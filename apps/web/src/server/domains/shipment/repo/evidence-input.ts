import {
  recordShipmentEvidenceInput,
  retainedShipmentEvidence,
  shipmentObservationInput,
  datedShipmentEventTime,
  type RecordShipmentEvidenceInput,
} from "@cubby/schemas/shipment-evidence";
import { shipmentPurpose } from "@cubby/schemas/shipment-fields";
import { z } from "zod";
// Pending preparations retain their literal provenance. This private Email ingress
// still requires dated observations and shares all source/identity/write enforcement.
export const retainedRecordInput = z.strictObject({
  ...recordShipmentEvidenceInput.shape,
  source: recordShipmentEvidenceInput.shape.source.options[0],
  shipments: z
    .array(
      retainedShipmentEvidence.safeExtend({
        purpose: shipmentPurpose,
        observations: z
          .array(
            shipmentObservationInput
              .extend({ time: datedShipmentEventTime })
              .refine(
                (event) =>
                  event.timeBasis !== "notification_received" ||
                  event.time.kind === "date",
                "Notification fallback uses its calendar date at date-only precision.",
              ),
          )
          .min(1)
          .max(500),
      }),
    )
    .min(1)
    .max(50),
});
export type ShipmentWriterInput = Omit<
  RecordShipmentEvidenceInput,
  "shipments"
> &
  Pick<z.infer<typeof retainedRecordInput>, "shipments">;
