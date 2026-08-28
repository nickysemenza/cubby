import {
  browserRoutedEntities,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { entityNames } from "@cubby/schemas/entity-names";
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
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  browserEntityDefinition,
  type EntityDetailRoute,
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
    // Item" once did. Both now come from the same manifest declaration, so a
    // mismatch here means one of the two derivations broke or a `label` went
    // back to being hand-typed. Re-implements the casing independently of
    // `entities.tsx` so the assertion isn't a tautology against its helper.
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

  it("takes every pluralLabel verbatim from the entity manifest", () => {
    // `pluralLabel` used to be a hand-typed map here; it is now declared as
    // `names.plural` on each entity literal. This pins the registry to the
    // manifest so the nav name can't be re-forked locally, and re-lists the
    // four that are NOT the naive plural of `label` — those are the reason
    // the value stays declared rather than computed from the singular.
    const declared = Object.fromEntries(
      browserRoutedEntities.map((entity) => [
        entity,
        entities[entity].pluralLabel,
      ]),
    );
    expect(declared).toEqual(
      Object.fromEntries(
        browserRoutedEntities.map((entity) => [
          entity,
          entityNames[entity].plural,
        ]),
      ),
    );

    expect(declared).toMatchObject({
      inventory: "Inventory",
      financialAccount: "Accounts",
      financialTransaction: "Transactions",
      wish: "Wishlist",
    });
  });
});

describe("entity names come from the key", () => {
  it("stamps every routed entity from its own manifest declaration", () => {
    // `withEntityNames` reads both names off the key, so a definition can no
    // longer name a different entity than the one it sits under. This walks
    // the registry against the manifest to prove the stamping is real rather
    // than 17 lucky coincidences.
    const wrong = browserRoutedEntities.filter(
      (entity) =>
        entities[entity].label !== entityNames[entity].singular ||
        entities[entity].pluralLabel !== entityNames[entity].plural,
    );
    expect(wrong).toEqual([]);
    expect(browserRoutedEntities.length).toBeGreaterThan(10);
  });

  it("keeps the definitions' literal types through the wrapper", () => {
    // The silent failure mode: a wrapper that widens these to `string` still
    // typechecks, and `EntityDetailRoute` quietly stops protecting links from
    // drifting. Nothing at runtime would notice, so pin it at the type level.
    expectTypeOf<EntityDetailRoute>().not.toEqualTypeOf<string>();
    expectTypeOf<"/wishes/$shortcode">().toMatchTypeOf<EntityDetailRoute>();
    expectTypeOf(entities.wish.pluralLabel).toEqualTypeOf<"Wishlist">();
    expectTypeOf(entities.inventory.label).toEqualTypeOf<"Inventory Item">();
  });
});
