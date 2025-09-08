import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { insertDataConfig } from "./system";
import { testConfig } from "~/testdata/test-config.data";
import { transformConfig } from "~/schemas/config";
import { createCallerFactory } from "../trpc";
import { appRouter } from "../root";

let prisma: PrismaClient;
describe("system test", () => {
  beforeEach(async () => {
    // Get a isolated test database
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });
  it("load data config", async () => {
    await insertDataConfig(prisma, transformConfig(testConfig));

    const createCaller = createCallerFactory(appRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });
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
