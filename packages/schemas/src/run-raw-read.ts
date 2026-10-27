import definition from "./entity-definitions/23-run.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawRunOut = definition.readSchemas.output;
export type RawRunOut = z.output<typeof rawRunOut>;
