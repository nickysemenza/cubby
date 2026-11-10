import { z } from "zod";
import { shortcodeSchema } from "./identifier-fields";

export const SHIPMENT_IDENTITY_PERIOD_DAYS = 60;

/** Reconciled event facts are published as one revision for all list projections. */
export const shipmentEventSummarySchema = z.object({
  firstEventDate: z.string().nullable(),
  lastEventDate: z.string().nullable(),
  eventSpanHours: z.number().nonnegative().nullable(),
  eventSpanLabel: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
});

export const shipmentPurpose = z.enum(["incoming", "outgoing", "unknown"]);
export type ShipmentPurpose = z.infer<typeof shipmentPurpose>;

const shipmentExtraTrackingNumber = z.object({
  carrierId: shortcodeSchema("vendor").nullable(),
  carrierName: z.string().nullable(),
  trackingNumber: z.string().min(1),
});
export const shipmentExtraTrackingNumbers = z.array(
  shipmentExtraTrackingNumber,
);
export type ShipmentExtraTrackingNumber = z.infer<
  typeof shipmentExtraTrackingNumber
>;
/**
 * `extraTrackingNumbers` on `entity.update`. Source intake owns adding a reference;
 * a member removes one by its key, so a stale client cannot drop one it never saw.
 */
export const shipmentExtraTrackingNumberRemovals = z
  .array(
    z
      .strictObject({
        op: z.literal("remove"),
        key: z.strictObject({
          trackingNumber: shipmentExtraTrackingNumber.shape.trackingNumber,
          carrierId: shipmentExtraTrackingNumber.shape.carrierId,
        }),
      })
      .meta({ id: "ShipmentExtraTrackingNumberRemoval" }),
  )
  .min(1)
  .describe(
    "References to remove by tracking number and carrier; every key must be present.",
  );
export type ShipmentExtraTrackingNumberRemovals = z.infer<
  typeof shipmentExtraTrackingNumberRemovals
>;
