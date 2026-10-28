import { mealContract } from "~/contracts/meal.contract";

import { defineOperationDomain } from "../operation-catalog";

export const meal = /* @__PURE__ */ defineOperationDomain(mealContract);
