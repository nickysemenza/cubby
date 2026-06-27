import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { productTopLevelOut } from "./product";
import { unitMappingWithMetadata } from "./unitmapping-responses";

export const foodSummaryEnrichment = z.object({
  inferredUnitMappings: z.array(unitMappingWithMetadata),
  linkedProducts: z.array(productTopLevelOut),
});

export type FoodSummaryEnrichment = z.infer<typeof foodSummaryEnrichment>;

// Enhanced food summary with unit mappings and linked products.
export const foodSummaryWithLinkedProducts = foodSummary.extend({
  ...foodSummaryEnrichment.shape,
});

export type FoodSummaryWithLinkedProducts = z.infer<
  typeof foodSummaryWithLinkedProducts
>;
