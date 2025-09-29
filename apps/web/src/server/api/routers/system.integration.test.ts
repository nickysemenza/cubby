import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { insertDataConfig } from "./system";
import { testConfig } from "~/testdata/test-config.data";
import { transformConfig } from "~/schemas/config";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { appRouter } from "../root";
import { unsafeProjectId } from "~/schemas/identifiers";

describe("system test", () => {
  let prisma: PrismaClient;
  let projectId: ReturnType<typeof unsafeProjectId>;
  beforeEach(async () => {
    const { prisma: db, projectId: pId, teardown } = await buildTestDB();
    prisma = db;
    projectId = unsafeProjectId(pId);
    return teardown;
  });
  it("load data config", async () => {
    await insertDataConfig(prisma, transformConfig(testConfig), projectId);

    const createCaller = createCallerFactory(appRouter);
    const caller = createCaller(
      createTestTRPCContext(prisma, {
        auth: { userId: "test-user-id" },
        projectId,
      }),
    );
    const list = await caller.ingredient.list({
      pagination: { pageSize: 100 },
      filters: {},
    });
    expect(list.items.length).toEqual(3);
    const ingredient = await caller.ingredient.getByName({
      nameFilter: "AP flour",
    });
    expect(ingredient).not.toBeNull();
    if (ingredient === null) {
      return;
    }
    expect(ingredient.name).toBe("All Purpose Flour");

    // create a recipe with the ingredient
    const recipe = await caller.recipe.insertCompact({
      name: "test recipe",
      sections: [{ instructions: ["mix"], ingredients: ["AP flour"] }],
    });
    expect(recipe.id).toBeDefined();
    const recipe2 = await caller.recipe.getByID({ id: recipe.id });
    expect(recipe2.name).toBe("test recipe");
  });
});
