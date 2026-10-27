import definition from "./entity-definitions/28-email.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawEmailOut = definition.readSchemas.output;
export type RawEmailOut = z.output<typeof rawEmailOut>;
