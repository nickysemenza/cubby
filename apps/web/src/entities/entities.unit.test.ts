import {
  browserRoutedEntities,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { financialAccountSortableFields } from "@cubby/schemas/financial-account";
import { financialTransactionSortableFields } from "@cubby/schemas/financial-transaction";
import { ENTITY_LABEL } from "@cubby/schemas/identifiers";
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
import {
  browserEntityDefinition,
  entities,
  entityLabel,
  isBrowserRoutedEntity,
} from "./entities";

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

describe("entity list first-visit density", () => {
  it("keeps registry density exceptions to read-heavy rosters", () => {
    const defaults = Object.fromEntries(
      browserRoutedEntities.map((entity) => [
        entity,
        browserEntityDefinition(entity).list?.defaultDensity,
      ]),
    );

    expect(defaults).toEqual({
      ingredient: undefined,
      product: undefined,
      recipe: undefined,
      cookbook: undefined,
      location: undefined,
      inventory: undefined,
      meal: undefined,
      project: undefined,
      task: undefined,
      vendor: "dense",
      purchase: undefined,
      expense: undefined,
      financialAccount: undefined,
      financialTransaction: "dense",
      wish: undefined,
      "usda-food": undefined,
      image: undefined,
    });
  });
});

describe("entity label parity", () => {
  it("title-cases ENTITY_LABEL for every shortcode entity with a browser route", () => {
    // Drift guard: `ENTITY_LABEL` (`@cubby/schemas/identifiers`, server error
    // prose, sentence case) and this registry's `.label` (UI chrome — nav,
    // headers, dialog titles — Title Case) used to be two hand-maintained
    // maps that could silently disagree, as "Inventory entry" vs. "Inventory
    // Item" once did. `.label` now derives from `ENTITY_LABEL` via
    // `titleCaseEntityLabel`, so a mismatch here means either that
    // derivation broke or a `label` field went back to being hand-typed —
    // this re-implements the same word-by-word title-case independently of
    // `entities.tsx` so the assertion isn't a tautology against its own
    // helper.
    const titleCase = (label: string): string =>
      label
        .split(" ")
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(" ");

    const covered = shortcodeEntities.filter((entity) =>
      isBrowserRoutedEntity(entity),
    );
    // Sanity check the guard itself isn't vacuous: every non-`ledgerParty`/
    // `ledgerTransfer` shortcode entity has a browser route today.
    expect(covered.length).toBe(shortcodeEntities.length - 2);

    for (const entity of covered) {
      expect(entityLabel(entity)).toBe(titleCase(ENTITY_LABEL[entity]));
    }

    // The concrete case this replaced: one word choice, not a casing quirk.
    expect(ENTITY_LABEL.inventory).toBe("Inventory item");
    expect(entityLabel("inventory")).toBe("Inventory Item");
  });
});
