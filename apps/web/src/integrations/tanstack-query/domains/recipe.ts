import { recipeContract } from "~/contracts/recipe.contract";

import { defineOperationDomain } from "../operation-catalog";

export const recipe = /* @__PURE__ */ defineOperationDomain(recipeContract);
