import { readSchemas as definitionSchemas } from "./entity-definitions/30-sourceTransactionRecord.entity";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawSourceTransactionRecordOut = definitionSchemas.output;
