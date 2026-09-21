import type { ScoredEntity } from "@cubby/schemas/data-quality";

import { cookbookChecks } from "./checks/cookbook";
import { ingredientChecks } from "./checks/ingredient";
import { inventoryChecks } from "./checks/inventory";
import { locationChecks } from "./checks/location";
import { mealChecks } from "./checks/meal";
import { productChecks } from "./checks/product";
import { productCategoryChecks } from "./checks/product-category";
import { purchaseChecks } from "./checks/purchase";
import { recipeChecks } from "./checks/recipe";
import type { EntityChecks, ScoredTable } from "./registry";

/** The registry's owner contract: one entry per scored entity. */
export type DataQualityEntries = {
  readonly [E in ScoredEntity]: EntityChecks<E, ScoredTable>;
};

/**
 * Every scored entity's SQL bindings, keyed by entity. `satisfies` is the
 * gate: a manifest that declares `capabilities.dataQuality` for an entity
 * with no entry here — or an entry missing one of the entity's generated
 * check ids — fails typecheck. Exported with its inferred (per-table) type so
 * a roll-up can `alias()` a related table without losing its columns.
 */
export const dataQualityEntries = {
  product: productChecks,
  purchase: purchaseChecks,
  // pantry and garden entities
  recipe: recipeChecks,
  ingredient: ingredientChecks,
  cookbook: cookbookChecks,
  location: locationChecks,
  inventory: inventoryChecks,
  meal: mealChecks,
  productCategory: productCategoryChecks,
  // finance and project entities
} satisfies DataQualityEntries;
