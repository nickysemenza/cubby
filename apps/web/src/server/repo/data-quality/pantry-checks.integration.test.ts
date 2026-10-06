import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { productCategoryUpdateData } from "@cubby/schemas/product-category";
import { sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { upsertCookbook } from "~/server/repo/cookbook";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  ensureGlobalUnknownLocation,
  updateLocationAiDescription,
} from "~/server/repo/location/crud";
import { createMealWithEntityId } from "~/server/repo/meal/crud";
import {
  createProductCategory,
  updateProductCategory,
} from "~/server/repo/product-category";
import { upsertCookbookRecipe } from "~/server/repo/recipe/crud";
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
  insertEntityAttachments,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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

  it("location: AI description", async () => {
    const gap = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ location gap" }),
      TEST_ACTOR,
    );
    const gapImage = await createImageFixture(ctx.db, "dq-location-gap");
    await insertEntityAttachments(ctx.db, {
      entityId: gap.entityId,
      imageId: gapImage.id,
      sortOrder: 0,
    });

    const complete = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ location complete", type: "shelf" }),
      TEST_ACTOR,
    );
    const completeImage = await createImageFixture(
      ctx.db,
      "dq-location-complete",
    );
    await insertEntityAttachments(ctx.db, {
      entityId: complete.entityId,
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
    expect(hydrated.get(gap.entityId)?.status).toBe("needs_data");

    expect(hydrated.get(complete.entityId)).toMatchObject({
      status: "complete",
      gaps: [],
    });
  });

  it("inventory: verified stock", async () => {
    // Two locations: `InventoryEntry_productId_locationId_key` forbids two
    // live stock rows for the same product/location/placement/ownership.
    const gapLocation = await ensureGlobalUnknownLocation(ctx.db, TEST_ACTOR);
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
        locationId: gapLocation.id,
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
    expect(hydrated.get(gap.entityId)?.gaps.map((g) => g.check)).toContain(
      "inventory_unknown_location",
    );
    // Parked in Unknown is consequential, not a free diagnostic.
    expect(hydrated.get(gap.entityId)?.score).toBeLessThanOrEqual(69);
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

  // Failure modes: whitespace-only steps passing as instructions; a line
  // naming a deleted Ingredient passing as an ingredient list.
  it("recipe: blank steps and deleted ingredients are not content", async () => {
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "DQ vanished flour" },
      TEST_ACTOR,
    );
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "DQ hollow recipe",
        url: "https://example.test/hollow",
        sections: [
          {
            instructions: [{ instruction: "Mix well" }],
            ingredients: [ingredientRef(ingredient.id)],
          },
        ],
      }),
      TEST_ACTOR,
    );
    const before = (
      await loadDataQualities(ctx.db, "recipe", [recipe.entityId])
    ).get(recipe.entityId);
    expect(before?.gaps).toEqual([]);

    await unwrapDb(ctx.db).execute(sql`
      UPDATE "RecipeSection" SET "instructions" = '[{"text": "   "}]'::jsonb
      WHERE "recipeId" = ${recipe.entityId}`);
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Ingredient" SET "deletedAt" = now() WHERE "shortcode" = ${ingredient.id}`);

    const after = (
      await loadDataQualities(ctx.db, "recipe", [recipe.entityId])
    ).get(recipe.entityId)!;
    expect(after.gaps.map((g) => g.check)).toEqual(
      expect.arrayContaining(["recipe_ingredients", "recipe_instructions"]),
    );
    expect(after.score).toBeLessThanOrEqual(69);
  });

  // Failure mode: a sub-recipe ingredient outliving its deleted Recipe and
  // still looking complete.
  it("ingredient: a sub-recipe ingredient whose recipe is deleted is a defect", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "DQ base sauce" }),
      TEST_ACTOR,
    );
    const wrapper = await insertWithShortcode(ctx.db, "ingredient", {
      name: "DQ base sauce (recipe)",
      recipeId: recipe.entityId,
    });
    const id = parseEntityId("ingredient", wrapper.id);
    const live = (await loadDataQualities(ctx.db, "ingredient", [id])).get(id);
    expect(live?.gaps.map((g) => g.check)).not.toContain(
      "ingredient_recipe_deleted",
    );

    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Recipe" SET "deletedAt" = now() WHERE "id" = ${recipe.entityId}`);
    const orphaned = (await loadDataQualities(ctx.db, "ingredient", [id])).get(
      id,
    )!;
    expect(orphaned.status).toBe("defect");
    expect(orphaned.gaps.map((g) => g.check)).toContain(
      "ingredient_recipe_deleted",
    );
    expect(orphaned.score).toBeLessThanOrEqual(49);
  });

  // Failure mode: a cooked meal whose only recipe was deleted still counting
  // as having contents.
  it("meal: a deleted recipe is not meal contents", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "DQ deleted meal recipe" }),
      TEST_ACTOR,
    );
    const meal = await createMealWithEntityId(
      ctx.db,
      {
        date: "2026-01-02",
        mealKind: "cooked",
        recipes: [{ recipeId: recipe.id, scale: 1 }],
      },
      TEST_ACTOR,
    );
    await unwrapDb(ctx.db).execute(sql`
      UPDATE "Recipe" SET "deletedAt" = now() WHERE "id" = ${recipe.entityId}`);
    const quality = (
      await loadDataQualities(ctx.db, "meal", [meal.entityId])
    ).get(meal.entityId)!;
    expect(quality.gaps.map((g) => g.check)).toContain("meal_contents");
    expect(quality.score).toBeLessThanOrEqual(69);
  });

  // Failure modes: an unmapped category passing; a deliberate "keep
  // unresolved" block or an inherited mapping wrongly flagged.
  it("productCategory: effective spending mapping, with blocked as a decision", async () => {
    const spending = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "DQ household spend",
    });
    const parent = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", {
        name: "DQ mapped parent",
        spendingCategoryMode: "mapped",
        spendingCategoryId: parseShortcodeFor(
          "spendingCategory",
          spending.shortcode,
        ),
      }),
      TEST_ACTOR,
    );
    const inherited = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", {
        name: "DQ inheriting child",
        parentId: parent.output.id,
      }),
      TEST_ACTOR,
    );
    const unmapped = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", { name: "DQ unmapped root" }),
      TEST_ACTOR,
    );
    const blocked = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", {
        name: "DQ blocked root",
        spendingCategoryMode: "blocked",
      }),
      TEST_ACTOR,
    );
    const ids = [parent, inherited, unmapped, blocked].map((c) => c.entityId);
    const hydrated = await loadDataQualities(ctx.db, "productCategory", ids);
    const flagged = (c: typeof parent) =>
      hydrated
        .get(c.entityId)
        ?.gaps.some((g) => g.check === "category_spending_category");
    expect(flagged(parent)).toBe(false);
    expect(flagged(inherited)).toBe(false);
    expect(flagged(blocked)).toBe(false);
    expect(flagged(unmapped)).toBe(true);
  });

  // Failure modes: a PDF asked for raster dimensions; a zero-sized raster
  // passing; a record whose stored bytes are gone looking healthy.
  it("image: raster dimensions and a usable stored asset", async () => {
    const pdf = await createImageFixture(ctx.db, "dq-manual", {
      contentType: "application/pdf",
      filename: "dq-manual.pdf",
    });
    const zero = await createImageFixture(ctx.db, "dq-zero", {
      width: 0,
      height: 480,
    });
    const lost = await createImageFixture(ctx.db, "dq-lost", {
      width: 640,
      height: 480,
      storageStatus: "missing",
    });
    const ids = [pdf, zero, lost].map((row) => parseEntityId("image", row.id));
    const hydrated = await loadDataQualities(ctx.db, "image", ids);
    const checks = (index: number) =>
      hydrated.get(ids[index]!)?.gaps.map((g) => g.check) ?? [];
    expect(checks(0)).not.toContain("image_dimensions");
    expect(checks(1)).toContain("image_dimensions");
    expect(checks(2)).toContain("image_asset_unusable");
    expect(hydrated.get(ids[2]!)?.status).toBe("defect");
    expect(hydrated.get(ids[2]!)?.score).toBeLessThanOrEqual(49);
  });

  it("productCategory: description and root feature", async () => {
    // A fresh root with a live `feature` would collide with the seeded
    // taxonomy root for that feature (`ProductCategory_feature_live_unique`
    // covers every value) — a `feature: null` root is still a legal insert
    // (the constraint is a partial index over non-null features), so the gap
    // case covers both `category_description` and `category_feature`.
    const gap = await createProductCategory(
      ctx.db,
      buildEntity("productCategory", { name: "DQ category gap" }),
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
        spendingCategoryMode: "blocked",
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
