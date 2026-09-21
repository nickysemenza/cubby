import { z } from "zod";

import { auditDateFilterFields } from "./base-entity";
import {
  generatedProductCategoryFieldSchemas,
  generatedProductCategoryFilterFields,
} from "./generated/entity-field-schemas.productCategory.gen";
import { productCategoryShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";

export type {
  ProductCategoryFeature,
  ProductCategoryPathNode,
  ProductCategorySummary,
} from "./product-category-fields";

export const productCategoryCreateInput = z.object(
  generatedProductCategoryFieldSchemas.create,
);
export type ProductCategoryCreateInput = z.infer<
  typeof productCategoryCreateInput
>;

export const productCategoryUpdateData = z.object(
  generatedProductCategoryFieldSchemas.update,
);
export type ProductCategoryUpdateData = z.infer<
  typeof productCategoryUpdateData
>;

export const productCategoryUpdateInput = z.object({
  id: productCategoryShortcode,
  data: productCategoryUpdateData,
});

export const productCategoryOut = z.object(
  generatedProductCategoryFieldSchemas.read,
);
export type ProductCategoryOut = z.infer<typeof productCategoryOut>;

export const productCategoryListResponse =
  createPaginatedResponseSchema(productCategoryOut);

export const productCategoryFilterFields = {
  ...auditDateFilterFields,
  ...generatedProductCategoryFilterFields,
};
export const productCategoryFilters = z.object(productCategoryFilterFields);
export type ProductCategoryFilters = z.infer<typeof productCategoryFilters>;
