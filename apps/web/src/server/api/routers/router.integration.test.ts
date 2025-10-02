import { beforeEach, describe, expect, it } from "vitest";
import { seedRealRecipes } from "~/testdata/seed";
import { recipeRouter } from "./recipe";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { exampleRecipesCompact } from "~/testdata/fakeRecipes";
import { type ProjectId } from "~/schemas/identifiers";

describe("recipe router", () => {
  let db: Database;
  let projectId: ProjectId;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, projectId, teardown } = await buildTestDB());
    return teardown;
  });
  it("recipe insert and retrieve", async () => {
    await seedRealRecipes(db, projectId);

    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );
    const recipeList = await caller.list({ filters: {} });
    expect(recipeList.items.length).toEqual(exampleRecipesCompact.length);
  });
});
