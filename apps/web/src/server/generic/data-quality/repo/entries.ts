import type { ScoredEntity } from "@cubby/schemas/data-quality";

import { cookbookChecks } from "~/server/generic/data-quality/repo/checks/cookbook";
import { deviceChecks } from "~/server/generic/data-quality/repo/checks/device";
import { emailChecks } from "~/server/generic/data-quality/repo/checks/email";
import { financialAccountChecks } from "~/server/generic/data-quality/repo/checks/financial-account";
import { gardenEntryChecks } from "~/server/generic/data-quality/repo/checks/garden-entry";
import { imageChecks } from "~/server/generic/data-quality/repo/checks/image";
import { imageJobChecks } from "~/server/generic/data-quality/repo/checks/image-job";
import { ingredientChecks } from "~/server/generic/data-quality/repo/checks/ingredient";
import { inventoryChecks } from "~/server/generic/data-quality/repo/checks/inventory";
import { ledgerPartyChecks } from "~/server/generic/data-quality/repo/checks/ledger-party";
import { ledgerTransferChecks } from "~/server/generic/data-quality/repo/checks/ledger-transfer";
import { locationChecks } from "~/server/generic/data-quality/repo/checks/location";
import { mealChecks } from "~/server/generic/data-quality/repo/checks/meal";
import { plantChecks } from "~/server/generic/data-quality/repo/checks/plant";
import { plantingChecks } from "~/server/generic/data-quality/repo/checks/planting";
import { productCategoryChecks } from "~/server/generic/data-quality/repo/checks/product-category";
import { projectChecks } from "~/server/generic/data-quality/repo/checks/project";
import { recipeChecks } from "~/server/generic/data-quality/repo/checks/recipe";
import { runChecks } from "~/server/generic/data-quality/repo/checks/run";
import { spendingCategoryChecks } from "~/server/generic/data-quality/repo/checks/spending-category";
import { vendorChecks } from "~/server/generic/data-quality/repo/checks/vendor";
import { wishChecks } from "~/server/generic/data-quality/repo/checks/wish";
import type {
  EntityChecks,
  ScoredTable,
} from "~/server/generic/data-quality/repo/registry";

import { expenseChecks } from "./checks/expense";
import { financialTransactionChecks } from "./checks/financial-transaction";
import { productChecks } from "./checks/product";
import { purchaseChecks } from "./checks/purchase";
import { taskChecks } from "./checks/task";

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
  run: runChecks,
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
  email: emailChecks,
  spendingCategory: spendingCategoryChecks,
  wish: wishChecks,
  plant: plantChecks,
  planting: plantingChecks,
  gardenEntry: gardenEntryChecks,
  ledgerParty: ledgerPartyChecks,
  ledgerTransfer: ledgerTransferChecks,
  device: deviceChecks,
  imageJob: imageJobChecks,
  image: imageChecks,
} satisfies DataQualityEntries;
