import type { Amount } from "@cubby/schemas/codec";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { createRecipeKernelTestCaller } from "tooling/entity-kernel-test-caller";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createRecipe } from "~/server/repo/recipe";
import { seedIngredientWithStock } from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("AvailabilityService.getRecipeAvailability", () => {
  const tdb = withTestDb();

  const ctx = () =>
    createTestRequestContext(tdb.db, {
      auth: { userId: TEST_ACTOR.userId },
    });
  const recipeCaller = () => createRecipeKernelTestCaller(tdb.db);

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
                ingredientId: parseShortcodeFor("ingredient", ingredientId),
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

  describe("sub-recipes", () => {
    const createSub = (
      name: string,
      recipeYield: { value: number; unit: string } | null,
      ingredients: { ingredientId: string; amounts: Amount[] }[],
    ) => {
      const data: Parameters<
        ReturnType<typeof createRecipeKernelTestCaller>["create"]
      >[0] = {
        name,
        meta: null,
        sections: [
          {
            ingredients: ingredients.map((i) => ({
              type: "ingredient" as const,
              ingredientId: parseShortcodeFor("ingredient", i.ingredientId),
              recipeId: null,
              amounts: i.amounts,
            })),
            instructions: [{ instruction: "Mix" }],
          },
        ],
      };
      if (recipeYield) data.yield = recipeYield;
      return recipeCaller().create(data);
    };

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
                recipeId: parseShortcodeFor("recipe", subRecipeId),
                ingredientId: null,
                amounts,
              },
              ...extras.map((e) => ({
                type: "ingredient" as const,
                ingredientId: parseShortcodeFor("ingredient", e.ingredientId),
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
