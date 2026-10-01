import { upsertCookbook } from "~/server/repo/cookbook";
import {
  makeCookbookExtraction,
  makeCookbookRecipe,
} from "~/server/repo/repo.fixtures";
import { saveMealFoodInput } from "@cubby/schemas/meal";
import type { Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import * as schema from "~/server/db/schema";
import { saveMealFood } from "~/server/repo/meal/food";
import { getDb } from "~/server/repo/database-helpers";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";
import {
  getFixtureDb,
  fixtureUserId,
  createEntityFixture,
} from "./fixtures-core";

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
  return result.output;
}

export async function seedStaplePlanningPrerequisite(page: Page, name: string) {
  const ingredient = await createEntityFixture(page, "ingredient", { name });
  const recipe = await createEntityFixture(page, "recipe", {
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
  await createEntityFixture(page, "meal", {
    date: "2026-09-09",
    name: `${name} meal`,
    recipes: [{ recipeId: recipe.id, scale: 1 }],
  });
  return { ingredient, recipe };
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
  const ingredient = await createEntityFixture(page, "ingredient", { name });
  const product = await createEntityFixture(page, "product", {
    name: `${name} Brand Product`,
    manufacturer: "E2E fixture",
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
}

export async function seedNutritionPrerequisite(
  page: Page,
  name: string,
  options: { missingCalories?: boolean } = {},
) {
  const measured = await createEntityFixture(page, "ingredient", {
    name: `${name} measured`,
  });
  const incomplete = await createEntityFixture(page, "ingredient", {
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
    [incomplete, options.missingCalories ? [] : [{ value: 50, unit: "kcal" }]],
  ] as const) {
    await createEntityFixture(page, "product", {
      name: `${ingredient.id} nutrition source`,
      manufacturer: "E2E fixture",
      ingredientId: ingredient.id,
      unitMappings: mappings.map((b) => ({
        a: { value: 100, unit: "g" },
        b,
        source: "E2E fixture",
      })),
    });
  }
  const recipe = await createEntityFixture(page, "recipe", {
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
  const db = getFixtureDb();
  const row = await getDb(db).query.recipe.findFirst({
    where: eq(schema.recipe.shortcode, recipe.id),
  });
  if (!row) throw new Error("Nutrition recipe fixture missing");
  const context = createTestRequestContext(db, {
    auth: { userId: await fixtureUserId(page) },
  });
  await context.services.recipeCosting.recompute([row.id]);
  const meal = await createEntityFixture(page, "meal", {
    date: "2026-09-09",
    name: `${name} meal`,
    recipes: [{ recipeId: recipe.id, scale: 1 }],
  });
  return { recipe, measured, incomplete, meal };
}

export async function seedMealNutritionPrerequisite(
  page: Page,
  name: string,
  options: { seedProductPortion?: boolean } = {},
) {
  const member = await createEntityFixture(page, "ledgerParty", {
    name: `${name} member`,
    kind: "member",
  });
  const guest = await createEntityFixture(page, "ledgerParty", {
    name: `${name} guest`,
    kind: "guest",
  });
  const ingredient = await createEntityFixture(page, "ingredient", {
    name: `${name} snack ingredient`,
  });
  const product = await createEntityFixture(page, "product", {
    name: `${name} snack`,
    manufacturer: "E2E fixture",
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
  const meal = await createEntityFixture(page, "meal", {
    date: today,
    name: `${name} meal`,
    mealType: "snack",
    mealKind: "other",
    recipes: [],
  });
  const futureMeal = await createEntityFixture(page, "meal", {
    date: futureDate,
    name: `${name} future meal`,
    mealType: "snack",
    mealKind: "other",
    recipes: [],
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
