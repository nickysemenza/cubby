import type { Amount } from "@cubby/schemas/codec";
import { unsafeIngredientShortcode } from "@cubby/schemas/identifiers";
import { manualUnitMapping } from "@cubby/schemas/unitmapping";
import { withEntityKernelMutations } from "tooling/entity-kernel-test-caller";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { getMealByShortcode, getMealsByDateRange } from "~/server/repo/meal";
import {
  createProductFixture,
  makeProductInput,
  seedIngredientWithStock,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { mealRouter } from "./meal";
import { recipeRouter } from "./recipe";

describe("mealRouter", () => {
  const ctx = withTestDb();

  const mealCaller = () =>
    withEntityKernelMutations(
      createTestCaller(mealRouter, ctx.db),
      "meal",
      ctx.db,
    );
  const recipeCaller = () =>
    withEntityKernelMutations(
      createTestCaller(recipeRouter, ctx.db),
      "recipe",
      ctx.db,
    );

  const createRecipe = (name: string, ingredientId: string, need: Amount) =>
    recipeCaller().create({
      name,
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId,
              recipeId: null,
              amounts: [need],
            },
          ],
          instructions: [{ instruction: "Mix" }],
        },
      ],
    });

  const seedFlourWithStock = (onHand: Amount) =>
    seedIngredientWithStock(ctx.db, { name: "flour", onHand }, TEST_ACTOR);

  it("plans recipes onto a day and lists them by date range", async () => {
    const flour = await findOrCreateIngredient(ctx.db, "flour");
    const recipe = await createRecipe("Pancakes", flour.shortcode, {
      value: 2,
      unit: "cup",
    });

    const meal = await mealCaller().create({
      date: "2026-06-15",
      name: "Dinner",
    });
    await mealCaller().addRecipe({
      mealId: meal.id,
      recipeId: recipe.id,
      scale: 2,
    });

    const inRange = await mealCaller().getByDateRange({
      from: "2026-06-14",
      to: "2026-06-16",
    });
    expect(inRange).toHaveLength(1);
    expect(inRange[0]!.name).toBe("Dinner");
    expect(inRange[0]!.recipes).toHaveLength(1);
    expect(inRange[0]!.recipes[0]!.scale).toBe(2);

    const empty = await mealCaller().getByDateRange({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(empty).toHaveLength(0);
  });

  it("cascade-soft-deletes a meal and its planned recipes", async () => {
    const flour = await findOrCreateIngredient(ctx.db, "flour");
    const recipe = await createRecipe("Pancakes", flour.shortcode, {
      value: 1,
      unit: "cup",
    });
    const meal = await mealCaller().create({ date: "2026-06-15" });
    await mealCaller().addRecipe({
      mealId: meal.id,
      recipeId: recipe.id,
      scale: 1,
    });

    await mealCaller().delete({ ids: [meal.id] });

    const after = await getMealsByDateRange(ctx.db, "2026-06-14", "2026-06-16");
    expect(after).toHaveLength(0);
    await expect(getMealByShortcode(ctx.db, meal.id)).resolves.toBeNull();
  });

  it("prices the shortfall from the product's money edge", async () => {
    // A price only reaches the shopping list when the product carries a unit
    // path to money. A bare per-each price cannot cost a gram shortfall —
    // there is no grams-per-each edge to cross — so the money edge is the
    // fixture, and its absence is exactly what `estimatedCost: null` reports.
    const flour = await findOrCreateIngredient(ctx.db, "flour");
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Priced flour",
        ingredientId: unsafeIngredientShortcode(flour.shortcode),
        unitMappings: [
          manualUnitMapping(
            { value: 1, unit: "cup" },
            { value: 120, unit: "g" },
          ),
          manualUnitMapping(
            { value: 120, unit: "g" },
            { value: 6, unit: "dollar" },
          ),
        ],
        price: 6,
      }),
      ctx.actor,
    );

    const recipe = await createRecipe("Bread", flour.shortcode, {
      value: 2,
      unit: "cup",
    }); // 240 g needed, nothing on hand

    const meal = await mealCaller().create({ date: "2026-12-01" });
    await mealCaller().addRecipe({
      mealId: meal.id,
      recipeId: recipe.id,
      scale: 1,
    });

    const list = await mealCaller().getShoppingList({
      from: "2026-11-30",
      to: "2026-12-02",
    });

    const item = list.items.find((i) => i.name === "flour");
    expect(item?.estimatedCost).toBeCloseTo(12, 2);
    expect(list.pricedItems).toBe(1);
    expect(list.estimatedTotal).toBeCloseTo(12, 2);
  });

  it("omits non-cooked meals from the shopping list and discloses them", async () => {
    const flour = await seedFlourWithStock({ value: 0, unit: "g" });
    const recipe = await createRecipe("Pancakes", flour.shortcode, {
      value: 1,
      unit: "cup",
    }); // 120 g

    const cooked = await mealCaller().create({
      date: "2026-11-02",
      name: "Sunday pancakes",
    });
    await mealCaller().addRecipe({
      mealId: cooked.id,
      recipeId: recipe.id,
      scale: 1,
    });

    const leftovers = await mealCaller().create({
      date: "2026-11-03",
      name: "Round two",
      mealKind: "leftovers",
    });
    await mealCaller().addRecipe({
      mealId: leftovers.id,
      recipeId: recipe.id,
      scale: 1,
    });

    const out = await mealCaller().create({
      date: "2026-11-04",
      name: "Anniversary",
      mealKind: "eating_out",
    });

    const list = await mealCaller().getShoppingList({
      from: "2026-11-01",
      to: "2026-11-05",
    });

    // Only the cooked meal is a column.
    expect(list.meals.map((m) => m.id)).toEqual([cooked.id]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.needValue).toBeCloseTo(120, 1);
    expect(list.items[0]!.perMeal).toHaveLength(1);

    expect(list.omittedMeals.map((m) => [m.id, m.mealKind]).sort()).toEqual(
      [
        [leftovers.id, "leftovers"],
        [out.id, "eating_out"],
      ].sort(),
    );
  });

  it("shopping list sums needs across meals but counts inventory ONCE", async () => {
    const flour = await seedFlourWithStock({ value: 500, unit: "g" });
    const recipeA = await createRecipe("A", flour.shortcode, {
      value: 2,
      unit: "cup",
    }); // 240 g
    const recipeB = await createRecipe("B", flour.shortcode, {
      value: 1,
      unit: "cup",
    }); // 120 g

    const m1 = await mealCaller().create({
      date: "2026-06-15",
      name: "Lunch",
    });
    await mealCaller().addRecipe({
      mealId: m1.id,
      recipeId: recipeA.id,
      scale: 1,
    });
    const m2 = await mealCaller().create({
      date: "2026-06-15",
      name: "Dinner",
    });
    await mealCaller().addRecipe({
      mealId: m2.id,
      recipeId: recipeB.id,
      scale: 2,
    }); // 2 × 120 g

    const list = await mealCaller().getShoppingList({
      from: "2026-06-14",
      to: "2026-06-16",
    });

    expect(list.meals).toHaveLength(2);
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    expect(item.name).toBe("flour");
    expect(item.basisUnit).toBe("g");
    expect(item.needValue).toBeCloseTo(480, 1);
    expect(item.haveValue).toBeCloseTo(500, 1);
    expect(item.shortfall).toBe(0);
    expect(item.status).toBe("ok");
    expect(item.perMeal).toHaveLength(2);
    expect(item.perMeal.map((c) => Math.round(c.needValue)).sort()).toEqual([
      240, 240,
    ]);
  });

  it("shopping list reports a shortfall when inventory is insufficient", async () => {
    const flour = await seedFlourWithStock({ value: 300, unit: "g" });
    const recipeA = await createRecipe("A", flour.shortcode, {
      value: 2,
      unit: "cup",
    }); // 240 g
    const recipeB = await createRecipe("B", flour.shortcode, {
      value: 2,
      unit: "cup",
    }); // 240 g

    const m1 = await mealCaller().create({ date: "2026-06-15" });
    await mealCaller().addRecipe({
      mealId: m1.id,
      recipeId: recipeA.id,
      scale: 1,
    });
    const m2 = await mealCaller().create({ date: "2026-06-15" });
    await mealCaller().addRecipe({
      mealId: m2.id,
      recipeId: recipeB.id,
      scale: 1,
    });

    const list = await mealCaller().getShoppingList({
      from: "2026-06-14",
      to: "2026-06-16",
    });
    const item = list.items[0]!;
    expect(item.needValue).toBeCloseTo(480, 1);
    expect(item.haveValue).toBeCloseTo(300, 1);
    expect(item.shortfall).toBeCloseTo(180, 1);
    expect(item.status).toBe("short");
  });

  describe("shopping list sub-recipes", () => {
    const createSub = (
      name: string,
      recipeYield: { value: number; unit: string } | null,
      ingredientId: string,
      need: Amount,
    ) =>
      recipeCaller().create({
        name,
        meta: null,
        ...(recipeYield ? { yield: recipeYield } : {}),
        sections: [
          {
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId,
                recipeId: null,
                amounts: [need],
              },
            ],
            instructions: [{ instruction: "Mix" }],
          },
        ],
      });

    const createParentUsing = (subRecipeId: string, amounts: Amount[]) =>
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
            ],
            instructions: [{ instruction: "Assemble" }],
          },
        ],
      });

    const planOne = async (recipeId: string, scale = 1) => {
      const meal = await mealCaller().create({
        date: "2026-06-15",
        name: "Dinner",
      });
      await mealCaller().addRecipe({ mealId: meal.id, recipeId, scale });
      return mealCaller().getShoppingList({
        from: "2026-06-14",
        to: "2026-06-16",
      });
    };

    it("includes ingredients reached through a sub-recipe", async () => {
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const sub = await createSub(
        "Dough",
        { value: 4, unit: "cup" },
        flour.shortcode,
        {
          value: 2,
          unit: "cup",
        },
      );
      const parent = await createParentUsing(sub.id, [
        { value: 2, unit: "cup" },
      ]);

      const list = await planOne(parent.id);

      expect(list.items).toHaveLength(1);
      const item = list.items[0]!;
      expect(item.name).toBe("flour");
      expect(item.needValue).toBeCloseTo(120, 1); // half the dough's 2 cups
      expect(item.perMeal[0]!.via.map((v) => v.name)).toEqual(["Dough"]);
      expect(list.unexpanded).toHaveLength(0);
    });

    it("counts inventory once across meals when reached via a sub-recipe", async () => {
      // The :96 invariant, re-run through the expansion path.
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const sub = await createSub(
        "Dough",
        { value: 2, unit: "cup" },
        flour.shortcode,
        {
          value: 2,
          unit: "cup",
        },
      );
      const parent = await createParentUsing(sub.id, [
        { value: 1, unit: "cup" },
      ]);

      const m1 = await mealCaller().create({ date: "2026-06-15" });
      await mealCaller().addRecipe({
        mealId: m1.id,
        recipeId: parent.id,
        scale: 1,
      });
      const m2 = await mealCaller().create({ date: "2026-06-16" });
      await mealCaller().addRecipe({
        mealId: m2.id,
        recipeId: parent.id,
        scale: 1,
      });

      const list = await mealCaller().getShoppingList({
        from: "2026-06-14",
        to: "2026-06-17",
      });

      const item = list.items[0]!;
      expect(item.needValue).toBeCloseTo(240, 1); // 2 × half a 2-cup dough
      expect(item.haveValue).toBeCloseTo(500, 1); // NOT 1000
      expect(item.perMeal).toHaveLength(2);
    });

    it("discloses an unexpandable sub-recipe without inventing an item", async () => {
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const sub = await createSub("Dough", null, flour.shortcode, {
        value: 2,
        unit: "cup",
      });
      const parent = await createParentUsing(sub.id, [
        { value: 2, unit: "cup" },
      ]);

      const list = await planOne(parent.id);

      expect(list.items).toHaveLength(0);
      expect(list.unexpanded).toHaveLength(1);
      const gap = list.unexpanded[0]!;
      expect(gap.name).toBe("Dough");
      expect(gap.reason).toBe("missingYield");
      expect(gap.parentRecipeName).toBe("Assembly");
      expect(gap.mealName).toBe("Dinner");
    });

    it("gives each planned line its own index when a meal repeats a recipe", async () => {
      // Two half-batches of the same recipe in one meal must stay two
      // distinguishable contributions, not collapse into one.
      const flour = await seedFlourWithStock({ value: 500, unit: "g" });
      const recipe = await createRecipe("Pancakes", flour.shortcode, {
        value: 1,
        unit: "cup",
      });
      const meal = await mealCaller().create({ date: "2026-06-15" });
      await mealCaller().addRecipe({
        mealId: meal.id,
        recipeId: recipe.id,
        scale: 1,
      });
      await mealCaller().addRecipe({
        mealId: meal.id,
        recipeId: recipe.id,
        scale: 2,
      });

      const list = await mealCaller().getShoppingList({
        from: "2026-06-14",
        to: "2026-06-16",
      });

      const perMeal = list.items[0]!.perMeal;
      expect(perMeal).toHaveLength(2);
      expect(new Set(perMeal.map((c) => c.lineIndex)).size).toBe(2);
    });
  });
});
