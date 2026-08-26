import {
  foodSummaryWithLinkedProducts,
  usdaFoodIdInput,
  usdaFoodListOut,
  usdaFoodLookupInput,
  usdaListInput,
} from "@cubby/schemas/usda";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const usdaFood = defineOperationDomain("usda-food", {
  list: query({
    input: usdaListInput,
    output: usdaFoodListOut,
    tags: [["usda-food"]],
  }),
  detail: query({
    input: usdaFoodIdInput,
    output: foodSummaryWithLinkedProducts.nullable(),
    tags: [["usda-food"]],
  }),
  alternateId: query({
    input: usdaFoodLookupInput,
    output: foodSummaryWithLinkedProducts.nullable(),
    tags: [["usda-food"]],
  }),
});
