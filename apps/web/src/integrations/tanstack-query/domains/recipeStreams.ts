import { recipeStreamsContract } from "~/contracts/recipe.contract";

import { defineOperationDomain } from "../operation-catalog";

export const recipeStreams = /* @__PURE__ */ defineOperationDomain(
  recipeStreamsContract,
);
