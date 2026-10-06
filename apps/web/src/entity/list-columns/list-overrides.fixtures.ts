import { cookbookListOverride } from "./cookbook";
import { expenseListOverride } from "./expense";
import {
  financialAccountListOverride,
  financialTransactionListOverride,
} from "./finance";
import { imageListOverride } from "./image";
import { ingredientListOverride } from "./ingredient";
import { inventoryListOverride } from "./inventory";
import { locationListOverride } from "./location";
import { mealListOverride } from "./meal";
import { productListOverride } from "./product";
import { purchaseListOverride } from "./purchase";
import { recipeListOverride } from "./recipe";
import { taskListOverride } from "./task";
import type { ListOverrideRegistry } from "./types";
import { wishListOverride } from "./wish";

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
