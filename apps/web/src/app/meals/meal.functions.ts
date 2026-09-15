import { mealContract } from "~/contracts/meal.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const meal = defineOperationDomain(mealContract, {
  getNutrition: {
    tags: [["meal", "getNutrition"], ["product"], ["recipe"], ["ledgerParty"]],
  },
  saveFood: { invalidates: ripple.meal },
  removeFood: { invalidates: ripple.meal },
  getByDateRange: { tags: [["meal", "getByDateRange"]] },
  upcomingSummary: { tags: [["meal", "upcomingSummary"]] },
  getPreparations: { tags: [["meal", "getPreparations"]] },
  getShoppingList: { tags: [["meal", "getShoppingList"]] },
  addRecipe: { invalidates: ripple.meal },
  updateRecipe: { invalidates: ripple.meal },
  removeRecipe: { invalidates: ripple.meal },
  savePreparation: { invalidates: ripple.meal },
});
