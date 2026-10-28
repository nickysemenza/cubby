import { readSchemas as definitionSchemas } from "./entity-definitions/29-imageJob.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawImageJobOut = definitionSchemas.output;
export type RawImageJobOut = z.output<typeof rawImageJobOut>;
