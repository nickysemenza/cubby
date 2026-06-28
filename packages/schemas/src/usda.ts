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
  createSortPaginationFields,
  createPaginatedResponseSchema,
} from "./pagination";
import { productTopLevelOut } from "./product";
import { unitMappingWithMetadata } from "./unitmapping";

export const usdaFoodSortableFields = [
  "fdc_id",
  "description",
  "data_type",
  "relevance",
  "linkedProducts",
] as const;

export type USDAFoodSortField = (typeof usdaFoodSortableFields)[number];

export const usdaListInput = z.object({
  filters: z.object({
    nameFilter: z.string().optional(),
    dataTypeFilter: dataTypeEnum.optional(),
    dataTypes: z.array(dataTypeEnum).optional(),
    foodsOnly: z.boolean().optional(),
    linkedProductsOnly: z.boolean().optional(),
  }),
  ...createSortPaginationFields({
    sortableFields: usdaFoodSortableFields,
    defaultSort: "fdc_id",
  }),
});

export const usdaFoodLookupInput = foodLookupParam;

export const usdaFoodIdInput = z.object({
  id: z.number().int().positive(),
});

export const usdaFoodEnrichmentsInput = z.object({
  fdcIds: z.array(z.number().int().positive()).max(1000),
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
