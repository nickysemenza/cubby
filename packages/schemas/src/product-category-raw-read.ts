import definition from "./entity-definitions/22-productCategory.entity";
import type { z } from "zod";

/** Repository/compiler reads; public entities use generated field envelopes. */
export const rawProductCategoryOut = definition.readSchemas.output;
export type RawProductCategoryOut = z.output<typeof rawProductCategoryOut>;
