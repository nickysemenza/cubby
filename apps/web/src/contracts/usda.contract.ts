import {
  foodSummaryWithLinkedProducts,
  usdaFoodIdInput,
  usdaFoodListOut,
  usdaFoodLookupInput,
  usdaListInput,
} from "@cubby/schemas/usda";

import { defineContract, query } from "~/contracts/define";

export const usdaFoodContract = defineContract("usda-food", {
  list: query({
    input: usdaListInput,
    output: usdaFoodListOut,
  }),
  detail: query({
    input: usdaFoodIdInput,
    output: foodSummaryWithLinkedProducts.nullable(),
  }),
  alternateId: query({
    input: usdaFoodLookupInput,
    output: foodSummaryWithLinkedProducts.nullable(),
  }),
});
