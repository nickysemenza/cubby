import { z } from "zod";
import { shortcodeSchema } from "./identifier-fields";
import { plainDate } from "./base-entity";

const text = z.string().trim().min(1);
export const shipmentEventKind = z.enum([
  "label_created",
  "vendor_shipped",
  "carrier_possession",
  "in_transit",
  "out_for_delivery",
  "delivery_attempt",
  "delivered",
  "exception",
  "returned",
  "cancelled",
  "unknown",
]);

// Local timestamps remain evidence; they are never silently interpreted in the server timezone.
export const shipmentEventTime = z.union([
  z.strictObject({
    kind: z.literal("instant"),
    value: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    kind: z.literal("date"),
    value: plainDate.refine(
      (value) => z.iso.date().safeParse(value).success,
      "Expected a real calendar day.",
    ),
  }),
  z.strictObject({
    kind: z.literal("local"),
    value: text.max(100),
    timezone: text.max(100).nullable(),
  }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export const shipmentObservationInput = z.strictObject({
  sourceEventKey: text.max(500).nullable(),
  kind: shipmentEventKind,
  time: shipmentEventTime,
  rawStatus: text.max(4000),
  location: text.max(500).nullable(),
  carrierId: shortcodeSchema("vendor").nullable(),
  carrierName: text.max(300).nullable(),
  trackingNumber: text.max(300).nullable(),
});
export type ShipmentObservationInput = z.infer<typeof shipmentObservationInput>;

export const shipmentEvidence = z
  .strictObject({
    shipmentId: shortcodeSchema("shipment").nullable(),
    sourceShipmentKey: text.max(500).nullable(),
    distinctPackageEvidence: text.max(2000).nullable(),
    carrierId: shortcodeSchema("vendor").nullable(),
    carrierName: text.max(300).nullable(),
    trackingNumber: text.max(300).nullable(),
    extraTrackingNumbers: z
      .array(
        z.strictObject({
          carrierId: shortcodeSchema("vendor").nullable(),
          carrierName: text.max(300).nullable(),
          trackingNumber: text.max(300),
        }),
      )
      .max(20),
    purpose: z.enum(["outbound", "replacement", "return", "unknown"]),
    observations: z.array(shipmentObservationInput).min(1).max(500),
  })
  .refine(
    (value) =>
      value.shipmentId ||
      value.trackingNumber ||
      (value.sourceShipmentKey && value.distinctPackageEvidence),
    {
      message:
        "A new trackingless Shipment needs a stable source shipment key and distinct-package evidence.",
    },
  );
export type ShipmentEvidence = z.infer<typeof shipmentEvidence>;

export const shipmentEvidenceSource = z.union([
  z.strictObject({
    kind: z.literal("email"),
    emailId: shortcodeSchema("email"),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("tracking_page"),
    url: z
      .url()
      .refine((value) => /^https?:/.test(value), "Use an HTTP(S) source URL."),
    externalKey: text.max(500),
    capturedAt: z.iso.datetime({ offset: true }),
    content: z
      .string()
      .min(1)
      .max(200000)
      .refine(
        (value) => value.trim().length > 0,
        "Capture content must not be blank.",
      ),
  }),
]);
export const recordShipmentEvidenceInput = z.strictObject({
  source: shipmentEvidenceSource,
  purchaseId: shortcodeSchema("purchase").nullable(),
  shipments: z.array(shipmentEvidence).min(1).max(50),
});
export type ShipmentEvidenceSource = z.infer<typeof shipmentEvidenceSource>;
export type RecordShipmentEvidenceInput = z.infer<
  typeof recordShipmentEvidenceInput
>;
export const recordShipmentEvidenceOut = z.object({
  shipmentIds: z.array(shortcodeSchema("shipment")),
  insertedObservations: z.number().int().nonnegative(),
  repeatedObservations: z.number().int().nonnegative(),
});
export const associateShipmentInput = z.strictObject({
  shipmentId: shortcodeSchema("shipment"),
  purchaseId: shortcodeSchema("purchase").nullable(),
});
export const mergeShipmentInput = z.strictObject({
  sourceId: shortcodeSchema("shipment"),
  targetId: shortcodeSchema("shipment"),
});
export const reassignShipmentEvidenceInput = z.strictObject({
  sourcePackageId: z.uuid(),
  targetShipmentId: shortcodeSchema("shipment"),
});
export const shipmentReferenceOut = z.object({
  shipmentId: shortcodeSchema("shipment"),
});
export const shipmentTimelineInput = z.strictObject({
  shipmentId: shortcodeSchema("shipment"),
});
export const shipmentTimelineObservation = shipmentObservationInput.extend({
  observationId: z.string().uuid(),
  sourceCaptureId: z.string().uuid(),
  sourcePackageId: z.string().uuid(),
  captureIds: z.array(z.uuid()),
  source: z.union([
    shipmentEvidenceSource.options[0],
    shipmentEvidenceSource.options[1].omit({ content: true }),
  ]),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  superseded: z.boolean(),
});
export const shipmentTimelineOut = z.object({
  shipmentId: shortcodeSchema("shipment"),
  observations: z.array(shipmentTimelineObservation),
  timeline: z.array(
    z.object({
      event: shipmentObservationInput,
      observationIds: z.array(z.string().uuid()),
    }),
  ),
  milestones: z.object({
    carrierPossessionAt: z.iso.datetime().nullable(),
    deliveredAt: z.iso.datetime().nullable(),
    fulfillmentHours: z.number().nonnegative().nullable(),
    transitHours: z.number().nonnegative().nullable(),
    totalWaitHours: z.number().nonnegative().nullable(),
    conflicts: z.array(z.string()),
  }),
});
