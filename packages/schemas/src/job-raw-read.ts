import definition from "./entity-definitions/32-job.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawJobOut = definition.readSchemas.output;
export type RawJobOut = z.output<typeof rawJobOut>;
