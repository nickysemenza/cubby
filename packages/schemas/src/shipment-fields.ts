import { z } from "zod";
import { shortcodeSchema } from "./identifier-fields";

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

export const shipmentExtraTrackingNumber = z.object({
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
