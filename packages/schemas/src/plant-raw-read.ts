import definition from "./entity-definitions/26-plant.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawPlantOut = definition.readSchemas.output;
export type RawPlantOut = z.output<typeof rawPlantOut>;
