import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { upsertImportRecipe } from "~/server/repo/import-recipe-convert";
import { createTestCaller } from "../trpc";
import { recipeRouter } from "./recipe";

// Minimal inline fixtures (was ~/testdata/fakeRecipes, removed with recipe.seed)
const TEST_RECIPES: ImportRecipe[] = [
  {
    meta: { title: "Pancakes" },
    sections: [
      {
        ingredients: ["1 cup flour", "1 cup milk", "1 egg"],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
    references: [],
  },
  {
    meta: { title: "Scrambled Eggs" },
    sections: [
      {
        ingredients: ["2 eggs", "1 tbsp butter"],
        instructions: ["Melt butter in pan", "Scramble eggs in pan"],
      },
    ],
    references: [],
  },
];

describe("recipe router", () => {
  const ctx = withTestDb();
  it("recipe insert and retrieve", async () => {
    for (const recipe of TEST_RECIPES) {
      await upsertImportRecipe(recipe, ctx.db, TEST_ACTOR);
    }

    const caller = createTestCaller(recipeRouter, ctx.db);
    const recipeList = await caller.list({ filters: {} });
    expect(recipeList.items.length).toEqual(TEST_RECIPES.length);
  });
});
