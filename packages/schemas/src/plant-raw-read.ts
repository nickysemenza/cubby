import { readSchemas as definitionSchemas } from "./entity-definitions/26-plant.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawPlantOut = definitionSchemas.output;
export type RawPlantOut = z.output<typeof rawPlantOut>;
