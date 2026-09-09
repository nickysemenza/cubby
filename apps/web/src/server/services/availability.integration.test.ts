import type { Amount } from "@cubby/schemas/codec";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { shoppingListInput } from "@cubby/schemas/meal";
import { createRecipeKernelTestCaller } from "tooling/entity-kernel-test-caller";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getIngredientByID, updateIngredient } from "~/server/repo/ingredient";
import { getInventoryForProducts } from "~/server/repo/inventory";
import { createMealWithEntityId } from "~/server/repo/meal/crud";
import { createRecipe } from "~/server/repo/recipe";
import {
  seedIngredientWithStock,
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";
import { getShoppingListWorkflow } from "~/server/workflows/meal.server";

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

  it("covers a usually-on-hand ingredient while preserving the missing inventory verdict", async () => {
    const flour = await seedFlourWithStock({ value: 0, unit: "g" });
    await updateIngredient(
      tdb.db,
      flour.id,
      { usuallyOnHand: true },
      TEST_ACTOR,
    );
    const recipe = await createFlourRecipe(flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const result = await ctx().services.availability.getRecipeAvailability(
      recipe.id,
    );
    const row = result.ingredients[0]!;

    expect(result.coverage).toBe(1);
    expect(result.missing).toEqual([]);
    expect(row.status).toBe("missing");
    expect(row.haveValue).toBe(0);
    expect(row.usuallyOnHand).toBe(true);
    expect(row.covered).toBe(true);
    expect(row.availabilitySource).toBe("assumed");
    expect(row.quantityIssues).toEqual([]);
  });

  it("aggregates selected meals once while keeping staples out of the buy total", async () => {
    const flour = await seedFlourWithStock({ value: 0, unit: "g" });
    await updateIngredient(
      tdb.db,
      flour.id,
      { usuallyOnHand: true },
      TEST_ACTOR,
    );
    const recipe = await createFlourRecipe(flour.shortcode, {
      value: 1,
      unit: "cup",
    });
    const meals = await Promise.all(
      ["2026-09-10", "2026-09-11"].map((date) =>
        createMealWithEntityId(
          tdb.db,
          {
            date,
            name: `Meal ${date}`,
            recipes: [{ recipeId: recipe.id, scale: 1 }],
          },
          TEST_ACTOR,
        ),
      ),
    );
    const [included, excluded] = meals;
    if (!included || !excluded) throw new Error("fixture setup failed");
    const result = await getShoppingListWorkflow(
      tdb.db,
      shoppingListInput.parse({
        from: "2026-09-10",
        to: "2026-09-11",
        excludedMealIds: [excluded.output.id],
      }),
      ctx().services.availability,
    );

    expect(result.meals.map((meal) => meal.id)).toEqual([
      included.output.id,
      excluded.output.id,
    ]);
    expect(result.items[0]).toMatchObject({
      membership: "usuallyOnHand",
      needValue: 120,
      status: "missing",
      covered: true,
      availabilitySource: "assumed",
      estimatedCost: null,
    });
    expect(result.estimatedTotal).toBe(0);
    expect(result.pricedItems).toBe(0);
    expect(result.items[0]?.perMeal).toHaveLength(1);
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

    it("prices only selected buy shortfalls while retaining staple and sub-recipe gaps", async () => {
      const flour = await seedFlourWithStock({ value: 150, unit: "g" });
      const salt = await seedIngredientWithStock(
        tdb.db,
        { name: "salt", onHand: { value: 0, unit: "g" } },
        TEST_ACTOR,
      );
      await updateIngredient(
        tdb.db,
        salt.id,
        { usuallyOnHand: true },
        TEST_ACTOR,
      );
      await createProductFixture(
        tdb.db,
        makeProductInput({
          name: "Priced flour",
          ingredientId: parseShortcodeFor("ingredient", flour.shortcode),
          price: 2,
          unitMappings: [
            {
              a: { value: 100, unit: "g" },
              b: { value: 1, unit: "whole" },
              source: null,
            },
          ],
        }),
        TEST_ACTOR,
      );
      const stockProducts = (
        await getIngredientByID(tdb.db, flour.id)
      ).product.map((product) => product.id);
      const stockIds = await resolveAllPresent(
        tdb.db,
        "product",
        stockProducts,
      );
      const stockBefore = await getInventoryForProducts(tdb.db, stockIds);
      const blocked = await createSub("Unspecified dough yield", null, [
        {
          ingredientId: flour.shortcode,
          amounts: [{ value: 1000, unit: "g" }],
        },
      ]);
      const parent = await createParent(
        blocked.id,
        [{ value: 1, unit: "g" }],
        [
          {
            ingredientId: flour.shortcode,
            amounts: [{ value: 200, unit: "g" }],
          },
          { ingredientId: salt.shortcode, amounts: [{ value: 10, unit: "g" }] },
          { ingredientId: salt.shortcode, amounts: [] },
        ],
      );
      const first = await createMealWithEntityId(
        tdb.db,
        { date: "2026-09-10", recipes: [{ recipeId: parent.id, scale: 1 }] },
        TEST_ACTOR,
      );
      const second = await createMealWithEntityId(
        tdb.db,
        { date: "2026-09-11", recipes: [{ recipeId: parent.id, scale: 1 }] },
        TEST_ACTOR,
      );
      const all = await getShoppingListWorkflow(
        tdb.db,
        { from: "2026-09-10", to: "2026-09-11" },
        ctx().services.availability,
      );
      expect(all.items.find((row) => row.name === "flour")).toMatchObject({
        membership: "buy",
        needValue: 400,
        haveValue: 150,
        shortfall: 250,
        estimatedCost: 5,
      });
      expect(all.items.find((row) => row.name === "salt")).toMatchObject({
        membership: "usuallyOnHand",
        needValue: null,
        quantityIssues: ["missingAmount"],
        estimatedCost: null,
      });
      expect(all.unexpanded).toHaveLength(2);
      expect(all.estimatedTotal).toBe(5);
      expect(all.pricedItems).toBe(1);
      const selected = await getShoppingListWorkflow(
        tdb.db,
        {
          from: "2026-09-10",
          to: "2026-09-11",
          excludedMealIds: [second.output.id],
        },
        ctx().services.availability,
      );
      expect(selected.meals.map((meal) => meal.id)).toEqual([
        first.output.id,
        second.output.id,
      ]);
      expect(selected.items.find((row) => row.name === "flour")).toMatchObject({
        needValue: 200,
        haveValue: 150,
        shortfall: 50,
        estimatedCost: 1,
      });
      expect(selected.estimatedTotal).toBe(1);
      expect(selected.unexpanded).toHaveLength(1);
      expect(await getInventoryForProducts(tdb.db, stockIds)).toEqual(
        stockBefore,
      );
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
