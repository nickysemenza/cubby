import { upsertCookbook } from "~/server/domains/cookbook/repo/cookbook";
import {
  makeCookbookExtraction,
  makeCookbookRecipe,
} from "~/server/testing/repo.fixtures";
import { saveMealFoodInput } from "@cubby/schemas/meal";
import type { Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { saveMealFood } from "~/server/domains/meal/repo/food";
import { getDb } from "~/server/db/helpers";
import { requireActor } from "~/server/http/request-context";
import { runMutationSideEffects } from "~/server/entity-kernel/repo/mutation-side-effects";
import { createTestRequestContext } from "~/server/testing/request-context";
import { drainRecipeRefreshJobs } from "~/server/testing/background-queue";
import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";
import {
  getFixtureDb,
  fixtureUserId,
  createEntityFixture,
  createFixtureGraph,
} from "./core";

export async function seedCookbookSourcePrerequisite(page: Page, name: string) {
  const db = getFixtureDb();
  const context = requireActor(
    createTestRequestContext(db, {
      auth: { userId: await fixtureUserId(page) },
    }),
  );
  const result = await upsertCookbook(
    db,
    {
      name,
      sourceLabel: "photo-fixture.epub",
      rawJson: makeCookbookExtraction([
        makeCookbookRecipe(`${name} carrots`, ["2 carrots"], {
          id: "001.0001",
          steps: ["Roast the carrots."],
          photos: [{ path: "OEBPS/images/hero.png", mime: "image/png" }],
        }),
        makeCookbookRecipe(`${name} potatoes`, ["2 potatoes"], {
          id: "001.0020",
          steps: ["Roast the potatoes."],
          photos: [{ path: "OEBPS/images/hero.png", mime: "image/png" }],
        }),
      ]),
    },
    context.actorContext,
  );
  // The import workflow refreshes the search document after the write; the
  // cookbook list's search filter reads it.
  await runMutationSideEffects(db, {
    action: "updated",
    entity: { entity: "cookbook", id: result.entityId },
    source: "cookbook.upsert",
  });
  return result.output;
}

export async function seedStaplePlanningPrerequisite(page: Page, name: string) {
  return createFixtureGraph(page, async (create) => {
    const ingredient = await create("ingredient", { name });
    const recipe = await create("recipe", {
      name: `${name} recipe`,
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient",
              ingredientId: ingredient.id,
              recipeId: null,
              amounts: [{ value: 10, unit: "g" }],
            },
          ],
          instructions: [{ instruction: "Mix." }],
        },
      ],
    });
    await create("meal", {
      date: "2026-09-09",
      name: `${name} meal`,
      recipes: [{ recipeId: recipe.id, scale: 1 }],
    });
    return { ingredient, recipe };
  });
}

/**
 * An ingredient priced by one linked product: 1 cup = $2.50 and 100 g = $1.50.
 * Recipe cost assertions depend on these exact mappings (2 cups → $5.00, and
 * 333 g through the chained cup → g conversion).
 */
export async function seedCostedIngredientPrerequisite(
  page: Page,
  name: string,
) {
  return createFixtureGraph(page, async (create) => {
    const ingredient = await create("ingredient", { name });
    const brand = await create("vendor", { name: "E2E fixture" });
    const product = await create("product", {
      brandId: brand.id,
      name: `${name} Brand Product`,
      ingredientId: ingredient.id,
      unitMappings: [
        {
          a: { value: 1, unit: "cup" },
          b: { value: 2.5, unit: "dollar" },
          source: "E2E fixture",
        },
        {
          a: { value: 100, unit: "grams" },
          b: { value: 1.5, unit: "dollar" },
          source: "E2E fixture",
        },
      ],
    });
    return { ingredient, product };
  });
}

export async function seedNutritionPrerequisite(
  page: Page,
  name: string,
  options: { missingCalories?: boolean } = {},
) {
  const { measured, incomplete, recipe } = await createFixtureGraph(
    page,
    async (create) => {
      const measured = await create("ingredient", {
        name: `${name} measured`,
      });
      const incomplete = await create("ingredient", {
        name: `${name} incomplete`,
      });
      for (const [ingredient, mappings] of [
        [
          measured,
          [
            { value: 100, unit: "kcal" },
            { value: 10, unit: "g protein" },
            { value: 0, unit: "mg sodium" },
            { value: 50, unit: "mg calcium" },
          ],
        ],
        [
          incomplete,
          options.missingCalories ? [] : [{ value: 50, unit: "kcal" }],
        ],
      ] as const) {
        const brand = await create("vendor", { name: "E2E fixture" });
        await create("product", {
          brandId: brand.id,
          name: `${ingredient.id} nutrition source`,
          ingredientId: ingredient.id,
          unitMappings: mappings.map((b) => ({
            a: { value: 100, unit: "g" },
            b,
            source: "E2E fixture",
          })),
        });
      }
      const recipe = await create("recipe", {
        name,
        servings: 2,
        yield: { value: 300, unit: "g" },
        meta: null,
        sections: [
          {
            ingredients: [
              {
                type: "ingredient",
                ingredientId: measured.id,
                recipeId: null,
                amounts: [{ value: 100, upperValue: 200, unit: "g" }],
              },
              {
                type: "ingredient",
                ingredientId: incomplete.id,
                recipeId: null,
                amounts: [{ value: 100, unit: "g" }],
              },
            ],
            instructions: [{ instruction: "Combine." }],
          },
        ],
      });
      return { measured, incomplete, recipe };
    },
  );
  const db = getFixtureDb();
  const row = await getDb(db).query.recipe.findFirst({
    where: eq(schema.recipe.shortcode, recipe.id),
  });
  if (!row) throw new Error("Nutrition recipe fixture missing");
  const context = createTestRequestContext(db, {
    auth: { userId: await fixtureUserId(page) },
  });
  const meal = await createEntityFixture(page, "meal", {
    date: "2026-09-09",
    name: `${name} meal`,
    recipes: [{ recipeId: recipe.id, scale: 1 }],
  });
  await context.services.recipeCosting.recompute([row.id]);
  await drainRecipeRefreshJobs(db, context.services.recipeCosting);
  return { recipe, measured, incomplete, meal };
}

export async function seedMealNutritionPrerequisite(
  page: Page,
  name: string,
  options: { seedProductPortion?: boolean } = {},
) {
  const {
    member,
    guest,
    ingredient,
    product,
    today,
    futureDate,
    inlineDate,
    meal,
    futureMeal,
  } = await createFixtureGraph(page, async (create) => {
    const member = await create("ledgerParty", {
      name: `${name} member`,
      kind: "member",
    });
    const guest = await create("ledgerParty", {
      name: `${name} guest`,
      kind: "guest",
    });
    const ingredient = await create("ingredient", {
      name: `${name} snack ingredient`,
    });
    const brand = await create("vendor", { name: "E2E fixture" });
    const product = await create("product", {
      brandId: brand.id,
      name: `${name} snack`,
      ingredientId: ingredient.id,
      labelNutrition: {
        servingGrams: 30,
        nutrients: { kcal: 120, protein: 3, carbs: 20, fat: 4 },
        source: "E2E package label",
      },
    });
    const today = householdLocalDate();
    const futureDate = householdDaysFromNow(2);
    const inlineDate = householdDaysFromNow(3);
    const meal = await create("meal", {
      date: today,
      name: `${name} meal`,
      mealType: "snack",
      mealKind: "other",
      recipes: [],
    });
    const futureMeal = await create("meal", {
      date: futureDate,
      name: `${name} future meal`,
      mealType: "snack",
      mealKind: "other",
      recipes: [],
    });
    return {
      member,
      guest,
      ingredient,
      product,
      today,
      futureDate,
      inlineDate,
      meal,
      futureMeal,
    };
  });
  const db = getFixtureDb();
  const context = requireActor(
    createTestRequestContext(db, {
      auth: { userId: await fixtureUserId(page) },
    }),
  );
  await saveMealFood(
    db,
    saveMealFoodInput.parse({
      mealId: meal.id,
      ledgerPartyId: guest.id,
      sourceKind: "manual",
      name: `${name} manual snack`,
      nutrients: { kcal: 250, protein: 20, carbs: 0 },
    }),
    context.actorContext,
  );
  if (options.seedProductPortion) {
    await saveMealFood(
      db,
      saveMealFoodInput.parse({
        mealId: meal.id,
        ledgerPartyId: member.id,
        sourceKind: "product",
        productId: product.id,
        amount: { value: 45, unit: "g" },
      }),
      context.actorContext,
    );
  }
  return {
    member,
    guest,
    product,
    ingredient,
    meal,
    futureMeal,
    today,
    futureDate,
    inlineDate,
    manualFoodName: `${name} manual snack`,
  };
}

export async function clearNutritionCachePrerequisite(shortcode: string) {
  await getDb(getFixtureDb()).execute(sql`UPDATE ${schema.recipe}
    SET "totals" = NULL, "totalsComputedAt" = NULL
    WHERE ${schema.recipe.shortcode} = ${shortcode}`);
}
