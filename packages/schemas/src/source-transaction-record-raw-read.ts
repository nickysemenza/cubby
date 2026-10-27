import definition from "./entity-definitions/30-sourceTransactionRecord.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawSourceTransactionRecordOut = definition.readSchemas.output;
export type RawSourceTransactionRecordOut = z.output<
  typeof rawSourceTransactionRecordOut
>;
