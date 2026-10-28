import { recipeAvailabilityContract } from "~/contracts/recipe.contract";

import { defineOperationDomain } from "../operation-catalog";

export const recipeAvailability = /* @__PURE__ */ defineOperationDomain(
  recipeAvailabilityContract,
);
