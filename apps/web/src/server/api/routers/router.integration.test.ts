import type { CompactRecipe } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCompactRecipe } from "~/codec/parser";
import type { Database } from "~/server/db";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { recipeRouter } from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

// Keep TEST_USER_ID for tRPC context
const TEST_USER_ID = TEST_ACTOR.userId;

// Minimal inline fixtures (was ~/testdata/fakeRecipes, removed with recipe.seed)
const TEST_RECIPES: CompactRecipe[] = [
  {
    name: "Pancakes",
    sections: [
      {
        ingredients: ["1 cup flour", "1 cup milk", "1 egg"],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
  },
  {
    name: "Scrambled Eggs",
    sections: [
      {
        ingredients: ["2 eggs", "1 tbsp butter"],
        instructions: ["Melt butter in pan", "Scramble eggs in pan"],
      },
    ],
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
      await upsertRecipeFromCompact(parseCompactRecipe(recipe), db, TEST_ACTOR);
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
