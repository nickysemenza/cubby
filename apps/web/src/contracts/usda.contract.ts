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
    readPolicy: "strong",
    native: "Native USDA food browse",
    input: usdaListInput,
    output: usdaFoodListOut,
  }),
  detail: query({
    readPolicy: "strong",
    native: "Native USDA food detail",
    input: usdaFoodIdInput,
    output: foodSummaryWithLinkedProducts.nullable(),
  }),
  // AI and externally hydrated food reads own authoritative database helpers.
  alternateId: query({
    readPolicy: "strong",
    input: usdaFoodLookupInput,
    output: foodSummaryWithLinkedProducts.nullable(),
  }),
});
