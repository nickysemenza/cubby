import { readSchemas as definitionSchemas } from "./entity-definitions/32-shipment.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawShipmentOut = definitionSchemas.output;
export type RawShipmentOut = z.output<typeof rawShipmentOut>;
