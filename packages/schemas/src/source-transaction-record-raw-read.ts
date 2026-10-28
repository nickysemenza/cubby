import { readSchemas as definitionSchemas } from "./entity-definitions/30-sourceTransactionRecord.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawSourceTransactionRecordOut = definitionSchemas.output;
export type RawSourceTransactionRecordOut = z.output<
  typeof rawSourceTransactionRecordOut
>;
