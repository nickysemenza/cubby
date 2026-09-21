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
    native: "Native USDA food browse",
    input: usdaListInput,
    output: usdaFoodListOut,
  }),
  detail: query({
    native: "Native USDA food detail",
    input: usdaFoodIdInput,
    output: foodSummaryWithLinkedProducts.nullable(),
  }),
  alternateId: query({
    input: usdaFoodLookupInput,
    output: foodSummaryWithLinkedProducts.nullable(),
  }),
});
