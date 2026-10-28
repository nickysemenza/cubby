import { readSchemas as definitionSchemas } from "./entity-definitions/27-spendingCategory.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawSpendingCategoryOut = definitionSchemas.output;
export type RawSpendingCategoryOut = z.output<typeof rawSpendingCategoryOut>;
