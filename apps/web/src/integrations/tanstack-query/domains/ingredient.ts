import { ingredientContract } from "~/contracts/ingredient.contract";

import { defineOperationDomain } from "../operation-catalog";

export const ingredient =
  /* @__PURE__ */ defineOperationDomain(ingredientContract);
