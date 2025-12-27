import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "~/schemas/context";
import {
  type OrganizationId,
  unsafeOrganizationId,
  unsafeUserId,
} from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { exampleRecipesCompact } from "~/testdata/fakeRecipes";
import { seedRealRecipes } from "~/testdata/seed";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { recipeRouter } from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  organizationId: unsafeOrganizationId("test-org-id"),
  source: "ui",
};

// Keep TEST_USER_ID for tRPC context
const TEST_USER_ID = TEST_ACTOR.userId;

describe("recipe router", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());
    return teardown;
  });
  it("recipe insert and retrieve", async () => {
    await seedRealRecipes(db, TEST_ACTOR);

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
