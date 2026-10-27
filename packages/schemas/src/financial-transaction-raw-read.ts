import definition from "./entity-definitions/14-financialTransaction.entity";
import type { z } from "zod";

/** Repository/compiler rows; public transaction reads use field envelopes. */
export const rawFinancialTransactionOut = definition.readSchemas.output;
export type RawFinancialTransactionOut = z.output<
  typeof rawFinancialTransactionOut
>;
