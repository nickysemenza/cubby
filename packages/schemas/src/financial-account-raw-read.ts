import { readSchemas as definitionSchemas } from "./entity-definitions/13-financialAccount.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawFinancialAccountOut = definitionSchemas.output;
export type RawFinancialAccountOut = z.output<typeof rawFinancialAccountOut>;
