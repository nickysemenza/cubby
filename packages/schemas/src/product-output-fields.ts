import productDefinition from "./entity-definitions/00-product.entity";

export const productTopLevelOut = productDefinition.readSchemas.output;

import { z } from "zod";
import { foodSummary } from "@cubby/usda";
import { unitMappingOut } from "./unitmapping";

export const productWithMappingsOut = productTopLevelOut.extend({
  unitMappings: z.array(unitMappingOut),
});
export const productWithMappingsAndFoodOut = productWithMappingsOut.extend({
  food: foodSummary.nullable(),
});
