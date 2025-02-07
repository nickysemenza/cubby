import { expect, it } from "vitest";
import { db } from "~/server/db";
import { seedRealRecipes } from "~/testdata/seed";
import { recipeRouter } from "./recipe";
import { createCallerFactory } from "../trpc";

// todo: point at test DB in CI
it.skip("recipe insert and retrieve", async () => {
  await seedRealRecipes(db);

  const createCaller = createCallerFactory(recipeRouter);
  const caller = createCaller({ headers: new Headers(), db });
  const recipeList = await caller.list({});
  expect(recipeList.items.length).toBeGreaterThan(3);
});
