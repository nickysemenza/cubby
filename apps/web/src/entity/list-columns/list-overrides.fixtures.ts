import { cookbookListOverride } from "../../features/cookbook/list-columns";
import { expenseListOverride } from "../../features/expense/list-columns";
import {
  financialAccountListOverride,
  financialTransactionListOverride,
} from "../../features/finance/list-columns";
import { imageListOverride } from "../../features/image/list-columns";
import { ingredientListOverride } from "../../features/ingredient/list-columns";
import { inventoryListOverride } from "../../features/inventory/list-columns";
import { locationListOverride } from "../../features/location/list-columns";
import { mealListOverride } from "../../features/meal/list-columns";
import { productListOverride } from "../../features/product/list-columns";
import { purchaseListOverride } from "../../features/purchase/list-columns";
import { recipeListOverride } from "../../features/recipe/list-columns";
import { taskListOverride } from "../../features/task/list-columns";
import { wishListOverride } from "../../features/wish/list-columns";
import type { ListOverrideRegistry } from "./types";

/**
 * Test-only coverage roster; production routes import their own declaration-bound module.
 * The hand-written half of each entity's list. An entity absent here renders
 * its declared columns generically (`createEntityDisplayColumns`) with the
 * contract's delete and no runtime picklists.
 */
export const listOverrides: ListOverrideRegistry = {
  cookbook: cookbookListOverride,
  expense: expenseListOverride,
  financialAccount: financialAccountListOverride,
  financialTransaction: financialTransactionListOverride,
  image: imageListOverride,
  ingredient: ingredientListOverride,
  inventory: inventoryListOverride,
  location: locationListOverride,
  meal: mealListOverride,
  product: productListOverride,
  purchase: purchaseListOverride,
  recipe: recipeListOverride,
  task: taskListOverride,
  wish: wishListOverride,
};
