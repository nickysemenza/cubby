import {
  brandedFoodInfo,
  dataTypeEnum,
  foodLookupParam,
  fdcId,
  foodInfo,
  foodPortion,
  legacyFoodInfo,
  nutritionInfo,
} from "@cubby/usda-schemas";
import { z } from "zod";
import {
  createPaginatedResponseSchema,
  sortPaginationFields,
} from "./pagination";
import { productTopLevelOut } from "./product";
import { unitMappingWithMetadata } from "./unitmapping";

export const usdaListInput = z.object({
  filters: z.object({
    nameFilter: z.string().optional(),
    dataTypeFilter: dataTypeEnum.optional(),
    dataTypes: z.array(dataTypeEnum).optional(),
    foodsOnly: z.boolean().optional(),
  }),
  ...sortPaginationFields,
});

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

const foodSummaryFields = {
  fdc_id: fdcId,
  brandedFoodInfo: brandedFoodInfo.nullable(),
  foodInfo,
  legacyFoodInfo: legacyFoodInfo.nullable(),
  nutritionInfo,
  portionInfoRaw: z.array(foodPortion),
};

// Enhanced food summary with unit mappings and linked products.
export const foodSummaryWithLinkedProducts = z.object({
  ...foodSummaryFields,
  inferredUnitMappings: z.array(unitMappingWithMetadata),
  linkedProducts: z.array(productTopLevelOut),
});

export type FoodSummaryWithLinkedProducts = z.infer<
  typeof foodSummaryWithLinkedProducts
>;

export const usdaFoodListOut = createPaginatedResponseSchema(
  foodSummaryWithLinkedProducts,
);

export const usdaFoodSummaryListOut = createPaginatedResponseSchema(
  z.object(foodSummaryFields),
);

export const usdaFoodEnrichmentsOut = z.record(
  z.string(),
  foodSummaryEnrichment,
);
