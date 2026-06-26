import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { productTopLevelOut } from "./product";
import { unitMappingWithMetadata } from "./unitmapping";

// Enhanced food summary with unit mappings and linked products.
export const foodSummaryWithLinkedProducts = foodSummary.extend({
  inferredUnitMappings: z.array(unitMappingWithMetadata),
  linkedProducts: z.array(productTopLevelOut),
});

export type FoodSummaryWithLinkedProducts = z.infer<
  typeof foodSummaryWithLinkedProducts
>;
