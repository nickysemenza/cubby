import { beforeEach, describe, expect, it } from "vitest";
import { seedRealRecipes } from "~/testdata/seed";
import { recipeRouter } from "./recipe";
import { createCallerFactory } from "../trpc";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { exampleRecipesCompact } from "~/testdata/fakeRecipes";

let prisma: PrismaClient;
describe("recipe router", () => {
  beforeEach(async () => {
    // Get a isolated test database
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });
  it("recipe insert and retrieve", async () => {
    await seedRealRecipes(prisma);

    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });
    const recipeList = await caller.list({ filters: {} });
    expect(recipeList.items.length).toEqual(exampleRecipesCompact.length);
  });
});
