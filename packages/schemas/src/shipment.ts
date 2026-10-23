import { z } from "zod";
import { shipmentBaseFilterFields } from "./generated/shipment.gen";

export {
  shipmentOut,
  shipmentUpdateData,
  type ShipmentOut,
  type ShipmentUpdateData,
} from "./generated/shipment.gen";
export const shipmentFilterFields = { ...shipmentBaseFilterFields };
export const shipmentFilters = z.object(shipmentFilterFields);
export type ShipmentFilters = z.infer<typeof shipmentFilters>;
