import { dataTypeEnum, foodLookupParam } from "@cubby/usda-schemas";
import { z } from "zod";
import {
  createSortPaginationFields,
  createPaginatedResponseSchema,
} from "./pagination";
import { generatedUSDAFoodFieldSchemas } from "./generated/entity-field-schemas.usda-food.gen";

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

// Enhanced food summary with unit mappings and linked products.
export const foodSummaryWithLinkedProducts = z.object(
  generatedUSDAFoodFieldSchemas.read,
);

export type FoodSummaryWithLinkedProducts = z.infer<
  typeof foodSummaryWithLinkedProducts
>;

export const foodSummaryEnrichment = foodSummaryWithLinkedProducts.pick({
  inferredUnitMappings: true,
  linkedProducts: true,
});

export type FoodSummaryEnrichment = z.infer<typeof foodSummaryEnrichment>;

export const usdaFoodListOut = createPaginatedResponseSchema(
  foodSummaryWithLinkedProducts,
);

export const usdaFoodSummaryListOut = createPaginatedResponseSchema(
  foodSummaryWithLinkedProducts.omit({
    inferredUnitMappings: true,
    linkedProducts: true,
  }),
);

export const usdaFoodEnrichmentsOut = z.record(
  z.string(),
  foodSummaryEnrichment,
);
