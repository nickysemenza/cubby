import { beforeEach, describe, expect, it } from "vitest";
import { seedRealRecipes } from "~/testdata/seed";
import { recipeRouter } from "./recipe";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { exampleRecipesCompact } from "~/testdata/fakeRecipes";
import { type OrganizationId, unsafeUserId } from "~/schemas/identifiers";

const TEST_USER_ID = unsafeUserId("test-user-id");

describe("recipe router", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());
    return teardown;
  });
  it("recipe insert and retrieve", async () => {
    await seedRealRecipes(db, organizationId, TEST_USER_ID);

    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId: organizationId,
      }),
    );
    const recipeList = await caller.list({ filters: {} });
    expect(recipeList.items.length).toEqual(exampleRecipesCompact.length);
  });
});
