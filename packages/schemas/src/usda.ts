import {
  dataTypeEnum,
  foodLookupParam,
  foodSummary,
} from "@cubby/usda-schemas";
import { z } from "zod";
import {
  createPaginatedResponseSchema,
  sortPaginationCombo,
} from "./pagination";
import { productTopLevelOut } from "./product";
import { unitMappingWithMetadata } from "./unitmapping-responses";

export const usdaListInput = z
  .object({
    filters: z.object({
      nameFilter: z.string().optional(),
      dataTypeFilter: dataTypeEnum.optional(),
      dataTypes: z.array(dataTypeEnum).optional(),
      foodsOnly: z.boolean().optional(),
    }),
  })
  .extend(sortPaginationCombo.shape);

export const usdaFoodLookupInput = foodLookupParam;

export const usdaFoodIdInput = z.object({
  id: z.number(),
});

export const usdaFoodEnrichmentsInput = z.object({
  fdcIds: z.array(z.number()).max(1000),
});

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

export const usdaFoodListOut = createPaginatedResponseSchema(
  foodSummaryWithLinkedProducts,
);

export const usdaFoodSummaryListOut =
  createPaginatedResponseSchema(foodSummary);

export const usdaFoodEnrichmentsOut = z.record(
  z.string(),
  foodSummaryEnrichment,
);
