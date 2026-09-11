import { usdaFoodContract } from "~/contracts/usda.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const usdaFood = defineOperationDomain(usdaFoodContract, {
  list: {
    tags: [["usda-food"]],
  },
  detail: {
    tags: [["usda-food"]],
    cache: "stable",
  },
  alternateId: {
    tags: [["usda-food"]],
  },
});
