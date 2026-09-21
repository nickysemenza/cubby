import {
  productCategoryCreateInput,
  productCategoryUpdateData,
} from "@cubby/schemas/product-category";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { locationImage } from "~/server/db/schema";
import { upsertCookbook } from "~/server/repo/cookbook";
import { getDb } from "~/server/repo/database-helpers";
import { updateLocationAiDescription } from "~/server/repo/location/crud";
import { createMealWithEntityId } from "~/server/repo/meal/crud";
import {
  createProductCategory,
  updateProductCategory,
} from "~/server/repo/product-category";
import { upsertCookbookRecipe } from "~/server/repo/recipe";
import {
  createIngredientFixture,
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createRecipeFixture,
  ingredientRef,
  makeCookbookExtraction,
  makeCookbookRecipe,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";

import { loadDataQualities } from "./hydrate";

/**
 * For each pantry/garden scored entity, one row that trips a real check and
 * one that satisfies it, asserted through `loadDataQualities` — the same
 * evaluation the list `dataStatus`/`dataGap` filters and the list's
 * `dataQuality` column read from (see `data-quality.integration.test.ts` for
 * the product/purchase equivalent).
 */
describe("data quality: pantry and garden entities", () => {
  const ctx = withTestDb();

  it("recipe: ingredients, instructions and source", async () => {
    const gap = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "DQ recipe gap" }),
      TEST_ACTOR,
    );
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "DQ flour" },
      TEST_ACTOR,
    );
    const complete = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "DQ recipe complete",
        url: "https://example.test/recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix well" }],
            ingredients: [ingredientRef(ingredient.id)],
          },
        ],
      }),
      TEST_ACTOR,
    );

    const hydrated = await loadDataQualities(ctx.db, "recipe", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("recipe_ingredients");
    expect(gapChecks).toContain("recipe_instructions");
    expect(gapChecks).toContain("recipe_source");
    expect(hydrated.get(gap.entityId)?.status).toBe("needs_data");

    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("ingredient: product link", async () => {
    const ownRecipeIngredient = await createIngredientFixture(
      ctx.db,
      { name: "DQ used ingredient" },
      TEST_ACTOR,
    );
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "DQ ingredient-user recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(ownRecipeIngredient.id)],
          },
        ],
      }),
      TEST_ACTOR,
    );
    const withProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ ingredientId: ownRecipeIngredient.id }),
      TEST_ACTOR,
    );
    expect(withProduct).toBeTruthy();

    const hydrated = await loadDataQualities(ctx.db, "ingredient", [
      ownRecipeIngredient.entityId,
    ]);
    expect(hydrated.get(ownRecipeIngredient.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("ingredient: product link missing", async () => {
    const unusedIngredient = await createIngredientFixture(
      ctx.db,
      { name: "DQ unused ingredient" },
      TEST_ACTOR,
    );
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "DQ unlinked ingredient recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(unusedIngredient.id)],
          },
        ],
      }),
      TEST_ACTOR,
    );

    const hydrated = await loadDataQualities(ctx.db, "ingredient", [
      unusedIngredient.entityId,
    ]);
    expect(
      hydrated.get(unusedIngredient.entityId)?.gaps.map((g) => g.check),
    ).toContain("ingredient_product");
  });

  it("cookbook: import completeness and cover image", async () => {
    const gap = await upsertCookbook(
      ctx.db,
      {
        name: "DQ Cookbook Gap",
        sourceLabel: "dq-gap.epub",
        rawJson: makeCookbookExtraction([
          makeCookbookRecipe("DQ Cookbook Gap Recipe", ["1 cup flour"]),
        ]),
      },
      TEST_ACTOR,
    );

    const cover = await createImageFixture(ctx.db, "dq-cookbook-cover");
    const complete = await upsertCookbook(
      ctx.db,
      {
        name: "DQ Cookbook Complete",
        sourceLabel: "dq-complete.epub",
        rawJson: makeCookbookExtraction([
          makeCookbookRecipe("DQ Cookbook Complete Recipe", ["1 cup flour"]),
        ]),
        coverImageId: cover.id,
      },
      TEST_ACTOR,
    );
    await upsertCookbookRecipe(
      makeRecipeInput({ name: "DQ Cookbook Complete Recipe" }),
      { id: complete.entityId, name: "DQ Cookbook Complete" },
      ctx.db,
      TEST_ACTOR,
    );

    const hydrated = await loadDataQualities(ctx.db, "cookbook", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("cookbook_import_incomplete");
    expect(gapChecks).toContain("cookbook_cover");
    expect(hydrated.get(gap.entityId)?.status).toBe("defect");

    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("location: AI description and type", async () => {
    const gap = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ location gap", type: null }),
      TEST_ACTOR,
    );
    const gapImage = await createImageFixture(ctx.db, "dq-location-gap");
    await getDb(ctx.db)
      .insert(locationImage)
      .values({ locationId: gap.entityId, imageId: gapImage.id, sortOrder: 0 });

    const complete = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ location complete", type: "shelf" }),
      TEST_ACTOR,
    );
    const completeImage = await createImageFixture(
      ctx.db,
      "dq-location-complete",
    );
    await getDb(ctx.db).insert(locationImage).values({
      locationId: complete.entityId,
      imageId: completeImage.id,
      sortOrder: 0,
    });
    await updateLocationAiDescription(
      ctx.db,
      complete.entityId,
      "A tidy pantry shelf.",
    );

    const hydrated = await loadDataQualities(ctx.db, "location", [
      gap.entityId,
      complete.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("location_ai_description");
    expect(gapChecks).toContain("location_type");
    expect(hydrated.get(gap.entityId)?.status).toBe("needs_data");

    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("inventory: verified stock", async () => {
    // Two locations: `InventoryEntry_productId_locationId_key` forbids two
    // live stock rows for the same product/location/placement/ownership.
    const gapLocation = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ inventory shelf gap" }),
      TEST_ACTOR,
    );
    const completeLocation = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ inventory shelf complete" }),
      TEST_ACTOR,
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "DQ inventory product" }),
      TEST_ACTOR,
    );
    const gap = await createInventoryFixture(
      ctx.db,
      {
        productId: product.entityId,
        locationId: gapLocation.entityId,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      TEST_ACTOR,
    );
    const complete = await createInventoryFixture(
      ctx.db,
      {
        productId: product.entityId,
        locationId: completeLocation.entityId,
        amount: { value: 1, unit: "each" },
        placement: "stock",
        verifiedAt: new Date(),
      },
      TEST_ACTOR,
    );

    const hydrated = await loadDataQualities(ctx.db, "inventory", [
      gap.entityId,
      complete.entityId,
    ]);
    expect(hydrated.get(gap.entityId)?.gaps.map((g) => g.check)).toContain(
      "inventory_verified",
    );
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("meal: recipe or food contents", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "DQ meal recipe" }),
      TEST_ACTOR,
    );
    const gap = await createMealWithEntityId(
      ctx.db,
      { date: "2026-01-01", mealKind: "cooked" },
      TEST_ACTOR,
    );
    const complete = await createMealWithEntityId(
      ctx.db,
      {
        date: "2026-01-01",
        mealKind: "cooked",
        recipes: [{ recipeId: recipe.id, scale: 1 }],
      },
      TEST_ACTOR,
    );

    const hydrated = await loadDataQualities(ctx.db, "meal", [
      gap.entityId,
      complete.entityId,
    ]);
    expect(hydrated.get(gap.entityId)?.gaps.map((g) => g.check)).toContain(
      "meal_contents",
    );
    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("productCategory: description and root feature", async () => {
    // A fresh root with a live `feature` would collide with the seeded
    // taxonomy root for that feature (`ProductCategory_feature_live_unique`
    // covers every value) — a `feature: null` root is still a legal insert
    // (the constraint is a partial index over non-null features), so the gap
    // case covers both `category_description` and `category_feature`.
    const gap = await createProductCategory(
      ctx.db,
      productCategoryCreateInput.parse({ name: "DQ category gap" }),
      TEST_ACTOR,
    );

    // The satisfied case reuses a seeded taxonomy root (already carrying a
    // live `feature`) rather than minting a second root for the same
    // feature; only its missing `description` needs filling in.
    const completeRoot = await updateProductCategory(
      ctx.db,
      taxonomyShortcode("tools"),
      productCategoryUpdateData.parse({
        description: "Hand and power tools.",
      }),
      TEST_ACTOR,
    );

    const hydrated = await loadDataQualities(ctx.db, "productCategory", [
      gap.entityId,
      completeRoot.entityId,
    ]);
    const gapChecks = hydrated.get(gap.entityId)?.gaps.map((g) => g.check);
    expect(gapChecks).toContain("category_description");
    expect(gapChecks).toContain("category_feature");

    expect(hydrated.get(completeRoot.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });
});
