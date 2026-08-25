import type { Amount } from "@cubby/schemas/codec";
import { unsafeIngredientShortcode } from "@cubby/schemas/identifiers";
import { withEntityKernelMutations } from "tooling/entity-kernel-test-caller";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createRecipe } from "~/server/repo/recipe";
import { seedIngredientWithStock } from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("AvailabilityService.getRecipeAvailability", () => {
  const tdb = withTestDb();

  const ctx = () =>
    createTestRequestContext(tdb.db, {
      auth: { userId: TEST_ACTOR.userId },
    });
  const recipeCaller = () => withEntityKernelMutations({}, "recipe", tdb.db);

  const createFlourRecipe = (ingredientId: string, need: Amount) =>
    createRecipe(
      tdb.db,
      {
        name: "Pancakes",
        meta: null,
        sections: [
          {
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: unsafeIngredientShortcode(ingredientId),
                recipeId: null,
                amounts: [need],
              },
            ],
            instructions: [{ instruction: "Mix" }],
          },
        ],
      },
      TEST_ACTOR,
    );

  const seedFlourWithStock = (onHand: Amount) =>
    seedIngredientWithStock(tdb.db, { name: "flour", onHand }, TEST_ACTOR);

  it("reports ok when inventory covers the recipe (across a unit conversion)", async () => {
    const flour = await seedFlourWithStock({ value: 500, unit: "g" }); // ~4.17 cups
    const recipe = await createFlourRecipe(flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.coverage).toBe(1);
    expect(result.totalIngredients).toBe(1);
    expect(result.availableIngredients).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.ingredients[0]!.status).toBe("ok");
    expect(result.ingredients[0]!.basisUnit).toBe("g");
    expect(result.ingredients[0]!.needValue).toBeCloseTo(240, 1); // 2 cups
    expect(result.ingredients[0]!.haveValue).toBeCloseTo(500, 1); // 500 g on hand
  });

  it("reports short when inventory is insufficient", async () => {
    const flour = await seedFlourWithStock({ value: 100, unit: "g" }); // ~0.83 cups
    const recipe = await createFlourRecipe(flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.coverage).toBe(0);
    expect(result.ingredients[0]!.status).toBe("short");
    expect(result.missing).toEqual(["flour"]);
  });

  it("reports missing when nothing is on hand", async () => {
    const flour = await findOrCreateIngredient(tdb.db, "flour");
    const recipe = await createFlourRecipe(flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.coverage).toBe(0);
    expect(result.ingredients[0]!.status).toBe("missing");
    expect(result.ingredients[0]!.haveValue).toBeNull();
  });

  it("reports unconvertible when units can't be reconciled", async () => {
    // On hand in "widget", but the only mapping is cup<->g: no path to "cup".
    const flour = await seedFlourWithStock({ value: 3, unit: "widget" });
    const recipe = await createFlourRecipe(flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );

    expect(result.ingredients[0]!.status).toBe("unconvertible");
    expect(result.ingredients[0]!.haveValue).toBeNull();
    expect(result.coverage).toBe(0);
  });

  describe("sub-recipes", () => {
    const createSub = (
      name: string,
      recipeYield: { value: number; unit: string } | null,
      ingredients: { ingredientId: string; amounts: Amount[] }[],
    ) =>
      recipeCaller().create({
        name,
        meta: null,
        ...(recipeYield ? { yield: recipeYield } : {}),
        sections: [
          {
            ingredients: ingredients.map((i) => ({
              type: "ingredient" as const,
              ingredientId: i.ingredientId,
              recipeId: null,
              amounts: i.amounts,
            })),
            instructions: [{ instruction: "Mix" }],
          },
        ],
      });

    const createParent = (
      subRecipeId: string,
      amounts: Amount[],
      extras: { ingredientId: string; amounts: Amount[] }[] = [],
    ) =>
      recipeCaller().create({
        name: "Assembly",
        meta: null,
        sections: [
          {
            ingredients: [
              {
                type: "recipe" as const,
                recipeId: subRecipeId,
                ingredientId: null,
                amounts,
              },
              ...extras.map((e) => ({
                type: "ingredient" as const,
                ingredientId: e.ingredientId,
                recipeId: null,
                amounts: e.amounts,
              })),
            ],
            instructions: [{ instruction: "Assemble" }],
          },
        ],
      });

    it("expands a sub-recipe's ingredients into the parent, scaled by yield", async () => {
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const sub = await createSub("Dough", { value: 4, unit: "cup" }, [
        { ingredientId: flour.shortcode, amounts: [{ value: 2, unit: "cup" }] },
      ]);
      const parent = await createParent(sub.id, [{ value: 2, unit: "cup" }]);

      const result = await ctx().services.availability.getRecipeAvailability(
        parent.id,
      );

      const row = result.ingredients.find((i) => i.name === "flour");
      expect(row?.needValue).toBeCloseTo(120, 1);
      expect(row?.status).toBe("ok");
      expect(row?.via.map((v) => v.name)).toEqual(["Dough"]);
      expect(result.ingredients.some((i) => i.status === "subrecipe")).toBe(
        false,
      );
      expect(result.unexpandedSubRecipes).toBe(0);
    });

    it("counts inventory once for an ingredient used directly and via a sub-recipe", async () => {
      // The double-count guard for per-ingredient grouping: 500 g on hand must
      // be counted once, not once per route to the ingredient.
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const sub = await createSub("Dough", { value: 2, unit: "cup" }, [
        { ingredientId: flour.shortcode, amounts: [{ value: 1, unit: "cup" }] },
      ]);
      const parent = await createParent(
        sub.id,
        [{ value: 2, unit: "cup" }],
        [
          {
            ingredientId: flour.shortcode,
            amounts: [{ value: 1, unit: "cup" }],
          },
        ],
      );

      const result = await ctx().services.availability.getRecipeAvailability(
        parent.id,
      );

      const rows = result.ingredients.filter((i) => i.name === "flour");
      expect(rows).toHaveLength(1); // one row per ingredient, not per mention
      expect(rows[0]!.needValue).toBeCloseTo(240, 1); // 1 cup direct + 1 cup via
      expect(rows[0]!.haveValue).toBeCloseTo(500, 1); // NOT 1000
    });

    it("flags a yield-less sub-recipe and excludes it from coverage", async () => {
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const sub = await createSub("Dough", null, [
        { ingredientId: flour.shortcode, amounts: [{ value: 2, unit: "cup" }] },
      ]);
      const parent = await createParent(
        sub.id,
        [{ value: 2, unit: "cup" }],
        [
          {
            ingredientId: flour.shortcode,
            amounts: [{ value: 1, unit: "cup" }],
          },
        ],
      );

      const result = await ctx().services.availability.getRecipeAvailability(
        parent.id,
      );

      const blocked = result.ingredients.find((i) => i.status === "subrecipe");
      expect(blocked?.blockedReason).toBe("missingYield");
      expect(result.unexpandedSubRecipes).toBe(1);
      // Coverage scores only the resolvable rows — the direct flour.
      expect(result.totalIngredients).toBe(1);
      expect(result.coverage).toBe(1);
    });

    it("terminates on a sub-recipe cycle", async () => {
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const caller = recipeCaller();
      const a = await createSub("A", { value: 2, unit: "cup" }, [
        { ingredientId: flour.shortcode, amounts: [{ value: 1, unit: "cup" }] },
      ]);
      const b = await createParent(a.id, [{ value: 1, unit: "cup" }]);
      await caller.update({
        id: a.id,
        data: {
          sections: [
            {
              ingredients: [
                {
                  type: "recipe" as const,
                  recipeId: b.id,
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "cup" }],
                },
              ],
              instructions: [{ instruction: "Mix" }],
            },
          ],
        },
      });

      const result = await ctx().services.availability.getRecipeAvailability(
        b.id,
      );

      expect(result.ingredients.some((i) => i.blockedReason === "cycle")).toBe(
        true,
      );
    }, 20_000);
  });
});
