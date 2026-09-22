import type { ScoredEntity } from "@cubby/schemas/data-quality";

import { cookbookChecks } from "./checks/cookbook";
import { deviceChecks } from "./checks/device";
import { expenseChecks } from "./checks/expense";
import { financialAccountChecks } from "./checks/financial-account";
import { financialTransactionChecks } from "./checks/financial-transaction";
import { gardenEntryChecks } from "./checks/garden-entry";
import { imageChecks } from "./checks/image";
import { ingredientChecks } from "./checks/ingredient";
import { inventoryChecks } from "./checks/inventory";
import { ledgerPartyChecks } from "./checks/ledger-party";
import { ledgerTransferChecks } from "./checks/ledger-transfer";
import { locationChecks } from "./checks/location";
import { mealChecks } from "./checks/meal";
import { plantingChecks } from "./checks/planting";
import { productChecks } from "./checks/product";
import { productCategoryChecks } from "./checks/product-category";
import { projectChecks } from "./checks/project";
import { purchaseChecks } from "./checks/purchase";
import { recipeChecks } from "./checks/recipe";
import { taskChecks } from "./checks/task";
import { vendorChecks } from "./checks/vendor";
import { wishChecks } from "./checks/wish";
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
  project: projectChecks,
  task: taskChecks,
  vendor: vendorChecks,
  financialAccount: financialAccountChecks,
  financialTransaction: financialTransactionChecks,
  expense: expenseChecks,
  wish: wishChecks,
  planting: plantingChecks,
  gardenEntry: gardenEntryChecks,
  ledgerParty: ledgerPartyChecks,
  ledgerTransfer: ledgerTransferChecks,
  device: deviceChecks,
  image: imageChecks,
} satisfies DataQualityEntries;
