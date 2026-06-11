import type { ActorContext } from "@cubby/schemas/context";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { upsertImportRecipe } from "~/server/repo/import-recipe-convert";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { recipeRouter } from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

// Keep TEST_USER_ID for tRPC context
const TEST_USER_ID = TEST_ACTOR.userId;

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
  let db: Database;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });
  it("recipe insert and retrieve", async () => {
    for (const recipe of TEST_RECIPES) {
      await upsertImportRecipe(recipe, db, TEST_ACTOR);
    }

    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );
    const recipeList = await caller.list({ filters: {} });
    expect(recipeList.items.length).toEqual(TEST_RECIPES.length);
  });
});
