import { z } from "zod";
import { shipmentFilterFields as shipmentBaseFilterFields } from "@cubby/schemas/entities/shipment";

export const shipmentFilterFields = { ...shipmentBaseFilterFields };
export const shipmentFilters = z.object(shipmentFilterFields);
export type ShipmentFilters = z.infer<typeof shipmentFilters>;
