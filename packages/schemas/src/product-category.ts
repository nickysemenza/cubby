import { productCategoryOut } from "./generated/productCategory.gen";
import { createPaginatedResponseSchema } from "./pagination";

export type {
  ProductCategoryFeature,
  ProductCategoryPathNode,
  ProductCategorySummary,
} from "./product-category-fields";

export {
  productCategoryCreateInput,
  productCategoryFilterFields,
  productCategoryFilters,
  productCategoryOut,
  productCategoryUpdateData,
  productCategoryUpdateInput,
  type ProductCategoryCreateInput,
  type ProductCategoryFilters,
  type ProductCategoryOut,
  type ProductCategoryUpdateData,
} from "./generated/productCategory.gen";

export const productCategoryListResponse =
  createPaginatedResponseSchema(productCategoryOut);
