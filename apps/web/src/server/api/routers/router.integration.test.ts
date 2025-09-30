import { beforeEach, describe, expect, it } from "vitest";
import { seedRealRecipes } from "~/testdata/seed";
import { recipeRouter } from "./recipe";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { exampleRecipesCompact } from "~/testdata/fakeRecipes";

describe("recipe router", () => {
  let prisma: PrismaClient;
  let projectId: string;
  beforeEach(async () => {
    const { prisma: db, projectId: pId, teardown } = await buildTestDB();
    prisma = db;
    projectId = pId;

    return teardown;
  });
  it("recipe insert and retrieve", async () => {
    await seedRealRecipes(prisma, projectId);

    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller(
      createTestTRPCContext(prisma, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );
    const recipeList = await caller.list({ filters: {} });
    expect(recipeList.items.length).toEqual(exampleRecipesCompact.length);
  });
});
