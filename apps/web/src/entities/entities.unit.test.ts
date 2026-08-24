import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import { financialAccountSortableFields } from "@cubby/schemas/financial-account";
import { financialTransactionSortableFields } from "@cubby/schemas/financial-transaction";
import { imageSortableFields } from "@cubby/schemas/image";
import { ingredientSortableFields } from "@cubby/schemas/ingredient";
import { inventorySortableFields } from "@cubby/schemas/inventory";
import { locationSortableFields } from "@cubby/schemas/location";
import { mealSortableFields } from "@cubby/schemas/meal";
import { productSortableFields } from "@cubby/schemas/product";
import {
  expenseSortableFields,
  projectSortableFields,
  taskSortableFields,
} from "@cubby/schemas/project";
import { purchaseSortableFields } from "@cubby/schemas/purchase";
import { recipeSortableFields } from "@cubby/schemas/recipe";
import { usdaFoodSortableFields } from "@cubby/schemas/usda";
import { vendorSortableFields } from "@cubby/schemas/vendor";
import { wishSortableFields } from "@cubby/schemas/wish";
import { describe, expect, it } from "vitest";
import { entities } from "./entities";

describe("entity sortableFields", () => {
  it("stays in sync with the canonical server schema contracts", () => {
    // The registry hand-lists these so route loaders never import the entity
    // schemas (validation graphs in the eager route tree); this is the pin.
    const declared = Object.fromEntries(
      browserRoutedEntities.map((entity) => [
        entity,
        entities[entity].sortableFields,
      ]),
    );
    expect(declared).toEqual({
      ingredient: ingredientSortableFields,
      product: productSortableFields,
      recipe: recipeSortableFields,
      cookbook: [],
      location: locationSortableFields,
      inventory: inventorySortableFields,
      meal: mealSortableFields,
      project: projectSortableFields,
      task: taskSortableFields,
      vendor: vendorSortableFields,
      purchase: purchaseSortableFields,
      expense: expenseSortableFields,
      financialAccount: financialAccountSortableFields,
      financialTransaction: financialTransactionSortableFields,
      wish: wishSortableFields,
      "usda-food": usdaFoodSortableFields,
      image: imageSortableFields,
    });
  });
});
