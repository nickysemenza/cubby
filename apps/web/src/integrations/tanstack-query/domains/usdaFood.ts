import { usdaFoodContract } from "~/contracts/usda.contract";

import { defineOperationDomain } from "../operation-catalog";

export const usdaFood = /* @__PURE__ */ defineOperationDomain(usdaFoodContract);
