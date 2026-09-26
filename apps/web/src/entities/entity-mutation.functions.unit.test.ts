import { describe, expect, it } from "vitest";

import { entityRipple, ripple } from "~/integrations/tanstack-query/cache-tags";

import { entityMutation } from "./entity-mutation.functions";

const hasTag = (tags: readonly (readonly string[])[], tag: readonly string[]) =>
  tags.some((candidate) => candidate.join(" ") === tag.join(" "));

/**
 * Regression coverage for two bugs masked by `useActionMutation` silently
 * skipping `invalidateQueryRoots` whenever `entity` was set: linking a USDA
 * food to an ingredient (via a product create) never refreshed usda-food
 * queries, and the ingredient-enrichment create paths never refreshed the
 * ingredient list. Both call sites create a Product through
 * `entityMutationOptionsFactory`, whose invalidation is `entityRipple("product")`
 * — correct for a plain product write, too narrow once the payload names an
 * ingredient/usda-food link.
 */
describe("entityMutation.mutate invalidates", () => {
  it("widens to ripple.ingredientProduct when a product create names an ingredient link", () => {
    const tags = entityMutation.mutate.invalidates({
      action: "create",
      entity: "product",
      data: {
        name: "Flour",
        upc: null,
        manufacturer: "generic",
        expectedQuantity: null,
        ingredientId: "ING-4K7M",
        fdc_id: null,
        categoryId: null,
      },
    });

    expect(hasTag(tags, ["ingredient"])).toBe(true);
    expect(hasTag(tags, ["product"])).toBe(true);
    expect(tags).toEqual(ripple.ingredientProduct);
  });

  it("also names usda-food when the same create carries an explicit fdc_id link", () => {
    // This is the enrich-ingredient-dialog / usda-food-actions "link to an
    // ingredient" shape: an ingredient link AND a real fdc_id together.
    const tags = entityMutation.mutate.invalidates({
      action: "create",
      entity: "product",
      data: {
        name: "Flour",
        upc: null,
        manufacturer: "generic",
        expectedQuantity: null,
        ingredientId: "ING-4K7M",
        fdc_id: 12345,
        categoryId: null,
      },
    });

    expect(hasTag(tags, ["usda-food"])).toBe(true);
    expect(hasTag(tags, ["ingredient"])).toBe(true);
    expect(tags).toEqual(ripple.ingredientProductUsdaFood);
  });

  it("does not widen a product create carrying no ingredient link", () => {
    const tags = entityMutation.mutate.invalidates({
      action: "create",
      entity: "product",
      data: {
        name: "Widget",
        upc: null,
        manufacturer: "generic",
        expectedQuantity: null,
        ingredientId: null,
        fdc_id: null,
        categoryId: null,
      },
    });

    expect(tags).toEqual(entityRipple("product"));
    expect(hasTag(tags, ["ingredient"])).toBe(false);
    expect(hasTag(tags, ["usda-food"])).toBe(false);
  });

  it("widens a product update the same way when its data names an ingredient link", () => {
    const tags = entityMutation.mutate.invalidates({
      action: "update",
      entity: "product",
      id: "PRD-4K7M",
      data: { ingredientId: "ING-4K7M" },
    });

    expect(tags).toEqual(ripple.ingredientProduct);
  });

  it("leaves non-product entities on the plain entityRipple fan-out", () => {
    const tags = entityMutation.mutate.invalidates({
      action: "create",
      entity: "vendor",
      data: { name: "Acme Supply" },
    });

    expect(tags).toEqual(entityRipple("vendor"));
  });

  // The per-entity attach/merge operations these commands replaced carried
  // wider ripples than a plain write of the owning entity.
  it("ripples a relation write to both ends and a product merge to cost and stock", () => {
    expect(
      entityMutation.mutate.invalidates({
        action: "attach",
        entity: "purchase",
        relation: "products",
        id: "PUR-4K7M",
        items: [{ id: "PRD-4K7M" }],
      }),
    ).toEqual(ripple.purchaseProduct);
    expect(
      entityMutation.mutate.invalidates({
        action: "merge",
        entity: "product",
        data: { keepId: "PRD-4K7M", mergeIds: ["PRD-4K7N"] },
      }),
    ).toEqual(ripple.productMerge);
  });

  it("refreshes Product reads after a category taxonomy write", () => {
    const tags = entityMutation.mutate.invalidates({
      action: "update",
      entity: "productCategory",
      id: "CAT-4K7M",
      data: { name: "Updated classification" },
    });

    expect(hasTag(tags, ["productCategory"])).toBe(true);
    expect(hasTag(tags, ["product"])).toBe(true);
    expect(hasTag(tags, ["inventory"])).toBe(true);
  });
});
