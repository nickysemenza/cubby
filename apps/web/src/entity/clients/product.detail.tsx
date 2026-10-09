import {
  ProductDetailActions,
  ProductOwnershipEvidence,
  ProductRuns,
} from "~/app/products/product-runs";
import {
  ProductCookbooks,
  ProductFitsWith,
  ProductLabels,
  ProductNutrition,
  ProductRecipeAppearances,
  ProductUnitMappings,
  ReviewLabelNutritionAction,
} from "~/app/products/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const productDetailHooks = defineDetailHooks("product", {
  slots: {
    ownership: { component: ProductOwnershipEvidence },
    nutrition: { component: ProductNutrition },
    "unit-mappings": { component: ProductUnitMappings },
    "fits-with": { component: ProductFitsWith },
    cookbooks: {
      component: ProductCookbooks,
      applies: (product) => product.cookbooks.length > 0,
    },
    "recipe-appearances": {
      component: ProductRecipeAppearances,
      applies: (product) => product.ingredient !== null,
    },
    labels: { component: ProductLabels },
    runs: { component: ProductRuns },
  },
  headerActions: ProductDetailActions,
  collectionActions: { reviewLabelNutrition: ReviewLabelNutritionAction },
});
