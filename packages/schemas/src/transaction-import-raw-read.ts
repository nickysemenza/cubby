import definition from "./entity-definitions/31-transactionImport.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawTransactionImportOut = definition.readSchemas.output;
export type RawTransactionImportOut = z.output<typeof rawTransactionImportOut>;
