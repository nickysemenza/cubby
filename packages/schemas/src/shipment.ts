import { z } from "zod";
import { shipmentBaseFilterFields } from "./generated/shipment.gen";

export { shipmentOut, type ShipmentOut } from "./generated/shipment.gen";
export const shipmentFilterFields = { ...shipmentBaseFilterFields };
export const shipmentFilters = z.object(shipmentFilterFields);
export type ShipmentFilters = z.infer<typeof shipmentFilters>;
