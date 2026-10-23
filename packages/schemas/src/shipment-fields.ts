import { z } from "zod";
import { shortcodeSchema } from "./identifier-fields";

export const shipmentPurpose = z.enum([
  "outbound",
  "replacement",
  "return",
  "unknown",
]);
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
