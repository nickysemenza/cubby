import { productCategoryOut } from "@cubby/schemas/entities/productCategory";
import { createPaginatedResponseSchema } from "./pagination";

export type {
  ProductCategoryFeature,
  ProductCategoryPathNode,
  ProductCategorySummary,
  RawProductCategorySummary,
} from "./product-category-fields";

export const productCategoryListResponse =
  createPaginatedResponseSchema(productCategoryOut);
