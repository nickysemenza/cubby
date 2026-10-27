import definition from "./entity-definitions/13-financialAccount.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawFinancialAccountOut = definition.readSchemas.output;
export type RawFinancialAccountOut = z.output<typeof rawFinancialAccountOut>;
