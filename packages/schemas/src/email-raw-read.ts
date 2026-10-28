import { readSchemas as definitionSchemas } from "./entity-definitions/28-email.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawEmailOut = definitionSchemas.output;
export type RawEmailOut = z.output<typeof rawEmailOut>;
